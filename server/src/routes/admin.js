// Dashboard stats, dropdown lookups, user management and the audit log.
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pg.js';
import { canEdit, requireRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { badRequest, notFound } from '../utils/errors.js';
import { cacheGet, cacheSet } from '../services/redis.js';
import { AuditLog, audit } from '../models/AuditLog.js';
import { Timetable } from '../models/Timetable.js';
import { publicUser } from './auth.js';

export const adminRouter = Router();

/** Counts for the dashboard. Cached in Redis for a minute (cache-aside pattern). */
adminRouter.get('/stats', canEdit, async (_req, res) => {
  const cached = await cacheGet('stats');
  if (cached) return res.set('X-Cache', 'HIT').json(cached);
  const { rows } = await query(`SELECT
    (SELECT count(*) FROM faculty) AS faculty, (SELECT count(*) FROM rooms) AS rooms,
    (SELECT count(*) FROM sections) AS sections, (SELECT count(*) FROM courses) AS courses,
    (SELECT count(*) FROM offerings) AS offerings, (SELECT count(*) FROM baskets) AS baskets,
    (SELECT count(*) FROM constraints) AS rules, (SELECT count(*) FROM users) AS users`);
  const [versions, published] = await Promise.all([Timetable.countDocuments(), Timetable.findOne({ published: true }).select('name publishedAt score stats').lean()]);
  const stats = { ...rows[0], versions, published: published ? { id: String(published._id), name: published.name, publishedAt: published.publishedAt, score: published.score, stats: published.stats } : null };
  await cacheSet('stats', stats, 60);
  res.set('X-Cache', 'MISS').json(stats);
});

/** Small id/name lists for dropdowns (not paginated). */
adminRouter.get('/lookups', canEdit, async (_req, res) => {
  const [faculty, sections, rooms, courses] = await Promise.all([
    query('SELECT id, name, department FROM faculty ORDER BY name'),
    query('SELECT id, name, size FROM sections ORDER BY name'),
    query('SELECT id, name, type, capacity FROM rooms ORDER BY name'),
    query('SELECT id, code, name, type FROM courses ORDER BY code'),
  ]);
  res.json({ faculty: faculty.rows, sections: sections.rows, rooms: rooms.rows, courses: courses.rows });
});

adminRouter.get('/users', requireRole('admin'), async (_req, res) => {
  const { rows } = await query('SELECT * FROM users ORDER BY created_at');
  res.json({ items: rows.map(publicUser) });
});

adminRouter.patch(
  '/users/:id',
  requireRole('admin'),
  validate({
    params: z.object({ id: z.coerce.number().int().positive() }),
    body: z.object({
      role: z.enum(['admin', 'hod', 'faculty', 'student']).optional(),
      facultyId: z.string().trim().min(1).nullable().optional(),
      sectionId: z.string().trim().min(1).nullable().optional(),
    }),
  }),
  async (req, res) => {
    const { id } = req.valid.params;
    const b = req.valid.body;
    if (id === req.user.id && b.role && b.role !== 'admin') throw badRequest('You cannot remove your own admin role');
    const sets = [];
    const params = [id];
    if (b.role) sets.push(`role = $${params.push(b.role)}`);
    if ('facultyId' in b) sets.push(`faculty_id = $${params.push(b.facultyId)}`);
    if ('sectionId' in b) sets.push(`section_id = $${params.push(b.sectionId)}`);
    if (!sets.length) throw badRequest('Nothing to change');
    const { rows } = await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    if (!rows[0]) throw notFound('User');
    audit(req.user, 'update', 'user', id, b);
    res.json(publicUser(rows[0]));
  },
);

adminRouter.get(
  '/audit',
  canEdit,
  validate({ query: z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(30), entity: z.string().trim().max(40).optional() }) }),
  async (req, res) => {
    const { page, limit, entity } = req.valid.query;
    const filter = entity ? { entity } : {};
    const [items, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AuditLog.countDocuments(filter),
    ]);
    res.json({ items: items.map(({ _id, ...x }) => ({ id: String(_id), ...x })), total, page, limit, pages: Math.ceil(total / limit) });
  },
);
