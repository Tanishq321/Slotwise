// Availability rules. Admins type a sentence, preview what it was understood as,
// then confirm. Saved rules become "unavailable" (hard) or "avoid" (soft) slots.
import { Router } from 'express';
import { z } from 'zod';
import { query, transaction } from '../db/pg.js';
import { canEdit } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AppError, badRequest, notFound } from '../utils/errors.js';
import { getSettings } from '../services/problemBuilder.js';
import { parseConstraintText } from '../services/constraintParser.js';
import { rateLimit } from '../services/redis.js';
import { audit } from '../models/AuditLog.js';

export const constraintsRouter = Router();

const ruleSchema = z.object({
  subjectType: z.enum(['faculty', 'section']),
  subjectId: z.string().trim().min(1),
  kind: z.enum(['unavailable', 'avoid']),
  day: z.number().int().min(0).max(6),
  periodFrom: z.number().int().min(0).max(15),
  periodTo: z.number().int().min(0).max(15),
  note: z.string().trim().max(200).optional(),
});

async function parserContext() {
  const settings = await getSettings();
  if (!settings) throw badRequest('Set up days and periods in Settings first');
  const [faculty, sections] = await Promise.all([query('SELECT id, name FROM faculty ORDER BY name'), query('SELECT id, name FROM sections ORDER BY name')]);
  return { ...settings, faculty: faculty.rows, sections: sections.rows };
}

constraintsRouter.get(
  '/',
  validate({ query: z.object({ subjectType: z.enum(['faculty', 'section']).optional(), subjectId: z.string().trim().optional() }) }),
  async (req, res) => {
    const { subjectType, subjectId } = req.valid.query;
    const params = [];
    const where = [];
    if (subjectType) where.push(`c.subject_type = $${params.push(subjectType)}`);
    if (subjectId) where.push(`c.subject_id = $${params.push(subjectId)}`);
    const { rows } = await query(
      `SELECT c.*, COALESCE(f.name, s.name) AS subject_name
       FROM constraints c
       LEFT JOIN faculty f ON c.subject_type = 'faculty' AND f.id = c.subject_id
       LEFT JOIN sections s ON c.subject_type = 'section' AND s.id = c.subject_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY subject_name, c.day, c.period_from`,
      params,
    );
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        subjectName: r.subject_name,
        kind: r.kind,
        day: r.day,
        periodFrom: r.period_from,
        periodTo: r.period_to,
        note: r.note,
        sourceText: r.source_text,
        createdAt: r.created_at,
      })),
    });
  },
);

// Preview only — nothing is saved here.
constraintsRouter.post('/parse', canEdit, validate({ body: z.object({ text: z.string().trim().min(3).max(500) }) }), async (req, res) => {
  // 30 parses per 10 minutes per user keeps us well inside Groq's free tier.
  const rl = await rateLimit(`parse:${req.user.id}`, 30, 600);
  if (!rl.allowed) throw new AppError(429, `Too many requests, try again in ${rl.resetIn}s`);
  const ctx = await parserContext();
  const result = await parseConstraintText(req.valid.body.text, ctx);
  res.json(result);
});

// Save confirmed rules (from the preview or entered by hand).
constraintsRouter.post(
  '/',
  canEdit,
  validate({ body: z.object({ constraints: z.array(ruleSchema).min(1).max(100), sourceText: z.string().trim().max(500).optional() }) }),
  async (req, res) => {
    const { constraints, sourceText } = req.valid.body;
    const settings = await getSettings();
    for (const c of constraints) {
      if (c.periodFrom > c.periodTo) throw badRequest('periodFrom must not be after periodTo');
      if (settings && (c.day >= settings.days.length || c.periodTo >= settings.periodsPerDay)) throw badRequest('A rule falls outside the timetable days or periods');
    }
    const ids = await transaction(async (client) => {
      const out = [];
      for (const c of constraints) {
        const table = c.subjectType === 'faculty' ? 'faculty' : 'sections';
        const exists = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [c.subjectId]);
        if (!exists.rowCount) throw badRequest(`Unknown ${c.subjectType} "${c.subjectId}"`);
        const { rows } = await client.query(
          `INSERT INTO constraints (subject_type, subject_id, kind, day, period_from, period_to, note, source_text, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [c.subjectType, c.subjectId, c.kind, c.day, c.periodFrom, c.periodTo, c.note ?? null, sourceText ?? null, req.user.id],
        );
        out.push(rows[0].id);
      }
      return out;
    });
    audit(req.user, 'create', 'constraint', ids.join(','), { count: ids.length, sourceText });
    res.status(201).json({ created: ids.length, ids });
  },
);

constraintsRouter.delete('/:id', canEdit, validate({ params: z.object({ id: z.coerce.number().int().positive() }) }), async (req, res) => {
  const r = await query('DELETE FROM constraints WHERE id = $1', [req.valid.params.id]);
  if (!r.rowCount) throw notFound('Rule');
  audit(req.user, 'delete', 'constraint', req.valid.params.id);
  res.status(204).end();
});
