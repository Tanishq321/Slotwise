// NEP 2020 elective baskets: students of several sections each pick one option
// (e.g. Entrepreneurship / Psychology / Digital Marketing). All options run at the
// same time, each with its own teacher and room, so no student ever has a clash.
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

export const basketsRouter = Router();

const optionSchema = z.object({
  offeringId: z.string().trim().optional(),
  courseId: z.string().trim().min(1),
  facultyId: z.string().trim().min(1),
  size: z.number().int().min(1).max(2000),
});
const schema = z
  .object({
    name: z.string().trim().min(1).max(80),
    sessionsPerWeek: z.number().int().min(1).max(10),
    sectionIds: z.array(z.string().trim().min(1)).min(1).max(40),
    options: z.array(optionSchema).min(2, 'A basket needs at least two options').max(20),
  })
  .refine((b) => new Set(b.options.map((o) => o.facultyId)).size === b.options.length, {
    message: 'Each option needs a different teacher, because all options run at the same time',
    path: ['options'],
  });

const SELECT = `
  SELECT b.*,
    COALESCE((SELECT json_agg(json_build_object('id', s.id, 'name', s.name, 'size', s.size) ORDER BY s.name)
              FROM basket_sections bs JOIN sections s ON s.id = bs.section_id WHERE bs.basket_id = b.id), '[]') AS sections,
    COALESCE((SELECT json_agg(json_build_object('offeringId', bo.offering_id, 'courseId', bo.course_id, 'courseCode', c.code,
                'courseName', c.name, 'facultyId', bo.faculty_id, 'facultyName', f.name, 'size', bo.size) ORDER BY c.code)
              FROM basket_options bo JOIN courses c ON c.id = bo.course_id JOIN faculty f ON f.id = bo.faculty_id
              WHERE bo.basket_id = b.id), '[]') AS options
  FROM baskets b`;

const fetchOne = async (id) => {
  const { rows } = await query(`${SELECT} WHERE b.id = $1`, [id]);
  if (!rows[0]) throw notFound('Elective basket');
  return toApi(rows[0]);
};

basketsRouter.get('/', async (_req, res) => {
  const { rows } = await query(`${SELECT} ORDER BY b.name`);
  res.json({ items: rows.map(toApi), total: rows.length });
});

basketsRouter.get('/:id', validate({ params: idParam }), async (req, res) => res.json(await fetchOne(req.valid.params.id)));

async function saveChildren(client, id, b) {
  const secIds = [...new Set(b.sectionIds)];
  const found = await client.query('SELECT id FROM sections WHERE id = ANY($1)', [secIds]);
  if (found.rowCount !== secIds.length) throw badRequest('One of the sections does not exist');
  await client.query('DELETE FROM basket_sections WHERE basket_id = $1', [id]);
  for (const s of secIds) await client.query('INSERT INTO basket_sections (basket_id, section_id) VALUES ($1, $2)', [id, s]);
  await client.query('DELETE FROM basket_options WHERE basket_id = $1', [id]);
  for (const o of b.options) {
    await client.query('INSERT INTO basket_options (offering_id, basket_id, course_id, faculty_id, size) VALUES ($1, $2, $3, $4, $5)', [
      o.offeringId || newId('opt'),
      id,
      o.courseId,
      o.facultyId,
      o.size,
    ]);
  }
}

basketsRouter.post('/', canEdit, validate({ body: schema }), async (req, res) => {
  const b = req.valid.body;
  const id = newId('bkt');
  await transaction(async (client) => {
    await client.query('INSERT INTO baskets (id, name, sessions_per_week) VALUES ($1, $2, $3)', [id, b.name, b.sessionsPerWeek]);
    await saveChildren(client, id, b);
  });
  await cacheDel('stats');
  audit(req.user, 'create', 'basket', id, b);
  res.status(201).json(await fetchOne(id));
});

basketsRouter.put('/:id', canEdit, validate({ params: idParam, body: schema }), async (req, res) => {
  const { id } = req.valid.params;
  const b = req.valid.body;
  await transaction(async (client) => {
    const r = await client.query('UPDATE baskets SET name = $2, sessions_per_week = $3 WHERE id = $1', [id, b.name, b.sessionsPerWeek]);
    if (!r.rowCount) throw notFound('Elective basket');
    await saveChildren(client, id, b);
  });
  audit(req.user, 'update', 'basket', id, b);
  res.json(await fetchOne(id));
});

basketsRouter.delete('/:id', canEdit, validate({ params: idParam }), async (req, res) => {
  const r = await query('DELETE FROM baskets WHERE id = $1', [req.valid.params.id]);
  if (!r.rowCount) throw notFound('Elective basket');
  await cacheDel('stats');
  audit(req.user, 'delete', 'basket', req.valid.params.id);
  res.status(204).end();
});
