// An offering = "this teacher teaches this course to these sections".
// Several sections in one offering means a combined class (one room, one slot).
import { Router } from 'express';
import { z } from 'zod';
import { query, transaction } from '../db/pg.js';
import { canEdit } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { badRequest, notFound } from '../utils/errors.js';
import { newId } from '../utils/ids.js';
import { audit } from '../models/AuditLog.js';
import { cacheDel } from '../services/redis.js';
import { idParam, toApi } from './crud.js';

export const offeringsRouter = Router();

const schema = z.object({
  courseId: z.string().trim().min(1),
  facultyId: z.string().trim().min(1),
  sectionIds: z.array(z.string().trim().min(1)).min(1, 'Pick at least one section').max(20),
  size: z.number().int().min(1).max(2000).nullable().optional(),
  // Optional overrides; leave empty to use the course's defaults.
  duration: z.number().int().min(1).max(6).nullable().optional(),
  sessionsPerWeek: z.number().int().min(1).max(10).nullable().optional(),
  maxSessionsPerDay: z.number().int().min(1).max(6).nullable().optional(),
});

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  sectionId: z.string().trim().optional(),
  facultyId: z.string().trim().optional(),
  courseId: z.string().trim().optional(),
  q: z.string().trim().max(100).optional(),
});

const SELECT = `
  SELECT o.id, o.course_id, o.faculty_id, o.size, o.duration, o.max_sessions_per_day,
         o.sessions_per_week AS custom_sessions_per_week,
         COALESCE(o.sessions_per_week, c.sessions_per_week) AS sessions_per_week,
         c.code AS course_code, c.name AS course_name, c.type AS course_type,
         f.name AS faculty_name,
         COALESCE(json_agg(json_build_object('id', s.id, 'name', s.name, 'size', s.size) ORDER BY s.name)
                  FILTER (WHERE s.id IS NOT NULL), '[]') AS sections,
         count(*) OVER() AS total_count
  FROM offerings o
  JOIN courses c ON c.id = o.course_id
  JOIN faculty f ON f.id = o.faculty_id
  LEFT JOIN offering_sections os ON os.offering_id = o.id
  LEFT JOIN sections s ON s.id = os.section_id`;
const GROUP = 'GROUP BY o.id, c.id, f.id';

offeringsRouter.get('/', validate({ query: listSchema }), async (req, res) => {
  const { page, limit, sectionId, facultyId, courseId, q } = req.valid.query;
  const where = [];
  const params = [];
  if (sectionId) {
    params.push(sectionId);
    where.push(`o.id IN (SELECT offering_id FROM offering_sections WHERE section_id = $${params.length})`);
  }
  if (facultyId) {
    params.push(facultyId);
    where.push(`o.faculty_id = $${params.length}`);
  }
  if (courseId) {
    params.push(courseId);
    where.push(`o.course_id = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    where.push(`(c.code ILIKE $${params.length} OR c.name ILIKE $${params.length} OR f.name ILIKE $${params.length})`);
  }
  params.push(limit, (page - 1) * limit);
  const { rows } = await query(
    `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${GROUP}
     ORDER BY c.code, o.id LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = rows[0]?.total_count ?? 0;
  res.json({ items: rows.map(toApi), total, page, limit, pages: Math.ceil(total / limit) });
});

async function saveSections(client, id, sectionIds) {
  const ids = [...new Set(sectionIds)];
  const found = await client.query('SELECT id FROM sections WHERE id = ANY($1)', [ids]);
  if (found.rowCount !== ids.length) throw badRequest('One of the sections does not exist');
  await client.query('DELETE FROM offering_sections WHERE offering_id = $1', [id]);
  for (const s of ids) await client.query('INSERT INTO offering_sections (offering_id, section_id) VALUES ($1, $2)', [id, s]);
}

const fetchOne = async (id) => {
  const { rows } = await query(`${SELECT} WHERE o.id = $1 ${GROUP}`, [id]);
  if (!rows[0]) throw notFound('Offering');
  return toApi(rows[0]);
};

offeringsRouter.get('/:id', validate({ params: idParam }), async (req, res) => res.json(await fetchOne(req.valid.params.id)));

offeringsRouter.post('/', canEdit, validate({ body: schema }), async (req, res) => {
  const b = req.valid.body;
  const id = newId('off');
  await transaction(async (client) => {
    await client.query(
      'INSERT INTO offerings (id, course_id, faculty_id, size, duration, sessions_per_week, max_sessions_per_day) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, b.courseId, b.facultyId, b.size ?? null, b.duration ?? null, b.sessionsPerWeek ?? null, b.maxSessionsPerDay ?? null],
    );
    await saveSections(client, id, b.sectionIds);
  });
  await cacheDel('stats');
  audit(req.user, 'create', 'offering', id, b);
  res.status(201).json(await fetchOne(id));
});

offeringsRouter.patch('/:id', canEdit, validate({ params: idParam, body: schema.partial() }), async (req, res) => {
  const { id } = req.valid.params;
  const b = req.valid.body;
  await transaction(async (client) => {
    const r = await client.query(
      `UPDATE offerings SET course_id = COALESCE($2, course_id), faculty_id = COALESCE($3, faculty_id),
         size = CASE WHEN $5 THEN $4 ELSE size END,
         duration = CASE WHEN $7 THEN $6 ELSE duration END,
         sessions_per_week = CASE WHEN $9 THEN $8 ELSE sessions_per_week END,
         max_sessions_per_day = CASE WHEN $11 THEN $10 ELSE max_sessions_per_day END
       WHERE id = $1`,
      [
        id, b.courseId ?? null, b.facultyId ?? null,
        b.size ?? null, 'size' in b,
        b.duration ?? null, 'duration' in b,
        b.sessionsPerWeek ?? null, 'sessionsPerWeek' in b,
        b.maxSessionsPerDay ?? null, 'maxSessionsPerDay' in b,
      ],
    );
    if (!r.rowCount) throw notFound('Offering');
    if (b.sectionIds) await saveSections(client, id, b.sectionIds);
  });
  audit(req.user, 'update', 'offering', id, b);
  res.json(await fetchOne(id));
});

offeringsRouter.delete('/:id', canEdit, validate({ params: idParam }), async (req, res) => {
  const r = await query('DELETE FROM offerings WHERE id = $1', [req.valid.params.id]);
  if (!r.rowCount) throw notFound('Offering');
  await cacheDel('stats');
  audit(req.user, 'delete', 'offering', req.valid.params.id);
  res.status(204).end();
});
