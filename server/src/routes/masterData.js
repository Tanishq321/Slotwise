// Faculty, rooms, sections and courses: plain tables built with the CRUD factory.
// Schemas deliberately have no .default() values — the database column defaults apply
// on create, and a PATCH only touches the fields that were actually sent.
import { z } from 'zod';
import { crudRouter } from './crud.js';
import { badRequest } from '../utils/errors.js';

const text = (max = 120) => z.string().trim().min(1).max(max);
const optionalText = (max = 120) => z.string().trim().max(max).nullable().optional();

export const facultySchema = z.object({
  name: text(),
  email: z.string().trim().toLowerCase().pipe(z.email()).nullable().optional(),
  department: optionalText(80),
  maxPerDay: z.number().int().min(1).max(12).optional(),
  maxPerWeek: z.number().int().min(1).max(60).optional(),
  canTeach: z.array(z.string().trim().min(1)).max(100).optional(),
});

export const roomSchema = z.object({
  name: text(60),
  type: z.enum(['lecture', 'lab']),
  capacity: z.number().int().min(1).max(2000),
  building: optionalText(80),
});

export const sectionSchema = z.object({
  name: text(60),
  program: optionalText(80),
  semester: z.number().int().min(1).max(12).nullable().optional(),
  size: z.number().int().min(1).max(2000),
});

export const courseSchema = z.object({
  code: text(30),
  name: text(),
  type: z.enum(['lecture', 'lab']),
  sessionsPerWeek: z.number().int().min(1).max(10),
  department: optionalText(80),
});

export const facultyRouter = crudRouter({
  table: 'faculty',
  entity: 'Faculty member',
  idPrefix: 'fac',
  schema: facultySchema,
  searchable: ['name', 'email', 'department'],
  sortable: ['name', 'department', 'maxPerWeek', 'createdAt'],
  filters: ['department'],
  virtualFields: ['canTeach'],
  extraSelect: `COALESCE((SELECT json_agg(course_id ORDER BY course_id) FROM faculty_can_teach WHERE faculty_id = t.id), '[]') AS can_teach,
    (SELECT count(*) FROM offerings o WHERE o.faculty_id = t.id) AS offering_count`,
  // "Can teach" is a many-to-many link table, saved in the same transaction.
  async afterWrite(client, id, body) {
    if (!body.canTeach) return;
    const ids = [...new Set(body.canTeach)];
    if (ids.length) {
      const found = await client.query('SELECT id FROM courses WHERE id = ANY($1)', [ids]);
      if (found.rowCount !== ids.length) throw badRequest('canTeach contains an unknown course');
    }
    await client.query('DELETE FROM faculty_can_teach WHERE faculty_id = $1', [id]);
    for (const courseId of ids) await client.query('INSERT INTO faculty_can_teach (faculty_id, course_id) VALUES ($1, $2)', [id, courseId]);
  },
});

export const roomsRouter = crudRouter({
  table: 'rooms',
  entity: 'Room',
  idPrefix: 'room',
  schema: roomSchema,
  searchable: ['name', 'building', 'type'],
  sortable: ['name', 'capacity', 'type', 'building', 'createdAt'],
  filters: ['type', 'building'],
});

export const sectionsRouter = crudRouter({
  table: 'sections',
  entity: 'Section',
  idPrefix: 'sec',
  schema: sectionSchema,
  searchable: ['name', 'program'],
  sortable: ['name', 'size', 'semester', 'createdAt'],
  filters: ['program', 'semester'],
});

export const coursesRouter = crudRouter({
  table: 'courses',
  entity: 'Course',
  idPrefix: 'crs',
  schema: courseSchema,
  searchable: ['code', 'name', 'department'],
  sortable: ['code', 'name', 'type', 'sessionsPerWeek', 'createdAt'],
  filters: ['type', 'department'],
});
