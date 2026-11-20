// Whole-dataset import/export (one JSON file with settings, rooms, teachers, classes,
// subjects, offerings, elective baskets and availability rules).
//
// Import replaces ALL master data in one transaction. Users and saved timetable
// versions are kept. Nothing is written unless the file passes the zod schema and the
// engine's own validateProblem check, so a bad file can never leave half a dataset.
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { validateProblem } from '@slotwise/engine';
import { query, transaction } from '../db/pg.js';
import { requireRole } from '../middleware/auth.js';
import { AppError, badRequest } from '../utils/errors.js';
import { audit } from '../models/AuditLog.js';
import { cacheDel } from '../services/redis.js';
import { getSettings } from '../services/problemBuilder.js';
import { settingsSchema } from './settings.js';

export const datasetRouter = Router();
export const DATASET_FORMAT = 'slotwise-dataset/1';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.json$/i.test(file.originalname) || file.mimetype === 'application/json';
    cb(ok ? null : badRequest('Please upload a .json dataset file'), ok);
  },
});

const id = z.string().trim().min(1).max(80);
const name = z.string().trim().min(1).max(120);
const optText = z.string().trim().max(120).nullish();
const ids = (max) => z.array(id).max(max);

const datasetSchema = z.object({
  format: z.literal(DATASET_FORMAT, { error: `This is not a Slotwise dataset (expected "format": "${DATASET_FORMAT}")` }),
  name: z.string().max(200).optional(),
  settings: settingsSchema,
  rooms: z.array(z.object({ id, name: z.string().trim().min(1).max(60), type: z.enum(['lecture', 'lab']), capacity: z.number().int().min(1).max(5000), building: optText })).max(2000),
  faculty: z
    .array(
      z.object({
        id,
        name,
        email: z.string().trim().toLowerCase().pipe(z.email()).nullish(),
        department: optText,
        maxPerDay: z.number().int().min(1).max(12).default(4),
        maxPerWeek: z.number().int().min(1).max(60).default(18),
        canTeach: ids(200).default([]),
      }),
    )
    .max(2000),
  sections: z.array(z.object({ id, name: z.string().trim().min(1).max(60), program: optText, semester: z.number().int().min(1).max(12).nullish(), size: z.number().int().min(1).max(5000) })).max(2000),
  courses: z
    .array(z.object({ id, code: z.string().trim().min(1).max(30), name, type: z.enum(['lecture', 'lab']), sessionsPerWeek: z.number().int().min(1).max(10), department: optText }))
    .max(2000),
  offerings: z
    .array(
      z.object({
        id,
        courseId: id,
        facultyId: id,
        sectionIds: ids(40).min(1),
        size: z.number().int().min(1).max(5000).nullish(),
        duration: z.number().int().min(1).max(6).nullish(),
        sessionsPerWeek: z.number().int().min(1).max(10).nullish(),
        maxSessionsPerDay: z.number().int().min(1).max(6).nullish(),
      }),
    )
    .max(10000),
  baskets: z
    .array(
      z.object({
        id,
        name: z.string().trim().min(1).max(80),
        sessionsPerWeek: z.number().int().min(1).max(10),
        duration: z.number().int().min(1).max(6).default(1),
        maxSessionsPerDay: z.number().int().min(1).max(6).nullish(),
        sectionIds: ids(40).min(1),
        options: z.array(z.object({ offeringId: id, courseId: id, facultyId: id, size: z.number().int().min(1).max(5000) })).min(2).max(20),
      }),
    )
    .max(500)
    .default([]),
  constraints: z
    .array(
      z.object({
        subjectType: z.enum(['faculty', 'section']),
        subjectId: id,
        kind: z.enum(['unavailable', 'avoid']),
        day: z.number().int().min(0),
        periodFrom: z.number().int().min(0),
        periodTo: z.number().int().min(0),
        note: z.string().max(200).nullish(),
      }),
    )
    .max(20000)
    .default([]),
});

// Same shape problemBuilder makes from the database, so the engine checks exactly what it will later solve.
function toProblem(d) {
  const expand = (c) => Array.from({ length: c.periodTo - c.periodFrom + 1 }, (_, i) => ({ day: c.day, period: c.periodFrom + i }));
  const rules = (type, sid, kind) => d.constraints.filter((c) => c.subjectType === type && c.subjectId === sid && c.kind === kind).flatMap(expand);
  return {
    config: { days: d.settings.days, periodsPerDay: d.settings.periodsPerDay, breaks: d.settings.breaks, labDuration: d.settings.labDuration },
    rooms: d.rooms,
    faculty: d.faculty.map((f) => ({ ...f, unavailable: rules('faculty', f.id, 'unavailable'), avoid: rules('faculty', f.id, 'avoid') })),
    sections: d.sections.map((s) => ({ ...s, unavailable: rules('section', s.id, 'unavailable') })),
    courses: d.courses,
    offerings: d.offerings.map((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null))),
    baskets: d.baskets,
  };
}

// Cross-references the engine does not look at (it only sees what is scheduled).
function referenceErrors(d) {
  const errors = [];
  const has = (list) => new Set(list.map((x) => x.id));
  const [fac, sec, crs] = [has(d.faculty), has(d.sections), has(d.courses)];
  const dup = (list, key, label) => {
    const seen = new Set();
    for (const x of list) {
      const k = String(x[key]).toLowerCase();
      if (seen.has(k)) errors.push({ code: 'DUPLICATE', message: `Two ${label} are both called "${x[key]}"` });
      seen.add(k);
    }
  };
  dup(d.rooms, 'name', 'rooms');
  dup(d.sections, 'name', 'classes');
  dup(d.courses, 'code', 'subjects');
  dup([...d.offerings, ...d.baskets], 'id', 'offerings/baskets (id)');
  dup(d.baskets.flatMap((b) => b.options).concat(d.offerings.map((o) => ({ offeringId: o.id }))), 'offeringId', 'offerings/basket options (id)');
  for (const f of d.faculty) for (const c of f.canTeach) if (!crs.has(c)) errors.push({ code: 'UNKNOWN_REF', message: `${f.name} can teach unknown subject "${c}"` });
  for (const c of d.constraints) {
    if (!(c.subjectType === 'faculty' ? fac : sec).has(c.subjectId)) errors.push({ code: 'UNKNOWN_REF', message: `A rule points to unknown ${c.subjectType} "${c.subjectId}"` });
    if (c.periodTo < c.periodFrom || c.periodTo >= d.settings.periodsPerDay || c.day >= d.settings.days.length)
      errors.push({ code: 'BAD_RULE', message: `A rule for "${c.subjectId}" is outside the week` });
  }
  return errors;
}

// Insert many rows in one statement: Postgres expands the JSON array into rows.
async function bulkInsert(client, table, columns, types, rows) {
  if (!rows.length) return;
  const cols = columns.join(', ');
  const def = columns.map((c, i) => `${c} ${types[i]}`).join(', ');
  await client.query(`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM json_to_recordset($1::json) AS x(${def})`, [JSON.stringify(rows)]);
}

datasetRouter.post('/', requireRole('admin'), upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Attach the dataset .json file in the "file" field');
  let raw;
  try {
    raw = JSON.parse(req.file.buffer.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw badRequest(`The file is not valid JSON: ${err.message}`);
  }
  const parsed = datasetSchema.safeParse(raw);
  if (!parsed.success) {
    const errors = parsed.error.issues.slice(0, 50).map((i) => ({ code: 'SCHEMA', message: `${i.path.join('.') || 'file'}: ${i.message}` }));
    throw new AppError(422, 'The dataset file has problems, nothing was imported', { errors });
  }
  const d = parsed.data;
  const errors = [...referenceErrors(d), ...validateProblem(toProblem(d))];
  if (errors.length) throw new AppError(422, `${errors.length} problem(s) in the dataset, nothing was imported`, { errors: errors.slice(0, 100) });

  await transaction(async (c) => {
    // Remember which logins were linked to a teacher/class so the links survive if the ids still exist.
    const links = (await c.query('SELECT id, faculty_id, section_id FROM users WHERE faculty_id IS NOT NULL OR section_id IS NOT NULL')).rows;
    for (const t of ['constraints', 'faculty_can_teach', 'basket_options', 'basket_sections', 'baskets', 'offering_sections', 'offerings', 'faculty', 'rooms', 'sections', 'courses'])
      await c.query(`DELETE FROM ${t}`);

    const s = d.settings;
    await c.query(
      `INSERT INTO settings (id, institution, days, periods_per_day, breaks, lab_duration, period_times, term_start, term_weeks)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET institution = $1, days = $2, periods_per_day = $3, breaks = $4,
         lab_duration = $5, period_times = $6, term_start = $7, term_weeks = $8`,
      [s.institution, JSON.stringify(s.days), s.periodsPerDay, JSON.stringify(s.breaks), s.labDuration, JSON.stringify(s.periodTimes), s.termStart ?? null, s.termWeeks],
    );
    await bulkInsert(c, 'rooms', ['id', 'name', 'type', 'capacity', 'building'], ['text', 'text', 'text', 'int', 'text'], d.rooms);
    await bulkInsert(c, 'sections', ['id', 'name', 'program', 'semester', 'size'], ['text', 'text', 'text', 'int', 'int'], d.sections);
    await bulkInsert(c, 'courses', ['id', 'code', 'name', 'type', 'sessions_per_week', 'department'], ['text', 'text', 'text', 'text', 'int', 'text'],
      d.courses.map((x) => ({ ...x, sessions_per_week: x.sessionsPerWeek })));
    await bulkInsert(c, 'faculty', ['id', 'name', 'email', 'department', 'max_per_day', 'max_per_week'], ['text', 'text', 'text', 'text', 'int', 'int'],
      d.faculty.map((f) => ({ ...f, max_per_day: f.maxPerDay, max_per_week: f.maxPerWeek })));
    await bulkInsert(c, 'faculty_can_teach', ['faculty_id', 'course_id'], ['text', 'text'],
      d.faculty.flatMap((f) => [...new Set(f.canTeach)].map((course_id) => ({ faculty_id: f.id, course_id }))));
    await bulkInsert(c, 'offerings', ['id', 'course_id', 'faculty_id', 'size', 'duration', 'sessions_per_week', 'max_sessions_per_day'],
      ['text', 'text', 'text', 'int', 'int', 'int', 'int'],
      d.offerings.map((o) => ({ id: o.id, course_id: o.courseId, faculty_id: o.facultyId, size: o.size, duration: o.duration, sessions_per_week: o.sessionsPerWeek, max_sessions_per_day: o.maxSessionsPerDay })));
    await bulkInsert(c, 'offering_sections', ['offering_id', 'section_id'], ['text', 'text'],
      d.offerings.flatMap((o) => [...new Set(o.sectionIds)].map((section_id) => ({ offering_id: o.id, section_id }))));
    await bulkInsert(c, 'baskets', ['id', 'name', 'sessions_per_week', 'duration', 'max_sessions_per_day'], ['text', 'text', 'int', 'int', 'int'],
      d.baskets.map((b) => ({ id: b.id, name: b.name, sessions_per_week: b.sessionsPerWeek, duration: b.duration, max_sessions_per_day: b.maxSessionsPerDay })));
    await bulkInsert(c, 'basket_sections', ['basket_id', 'section_id'], ['text', 'text'],
      d.baskets.flatMap((b) => [...new Set(b.sectionIds)].map((section_id) => ({ basket_id: b.id, section_id }))));
    await bulkInsert(c, 'basket_options', ['offering_id', 'basket_id', 'course_id', 'faculty_id', 'size'], ['text', 'text', 'text', 'text', 'int'],
      d.baskets.flatMap((b) => b.options.map((o) => ({ offering_id: o.offeringId, basket_id: b.id, course_id: o.courseId, faculty_id: o.facultyId, size: o.size }))));
    await bulkInsert(c, 'constraints', ['subject_type', 'subject_id', 'kind', 'day', 'period_from', 'period_to', 'note'], ['text', 'text', 'text', 'int', 'int', 'int', 'text'],
      d.constraints.map((x) => ({ subject_type: x.subjectType, subject_id: x.subjectId, kind: x.kind, day: x.day, period_from: x.periodFrom, period_to: x.periodTo, note: x.note })));

    for (const u of links) {
      await c.query(
        `UPDATE users SET faculty_id = (SELECT id FROM faculty WHERE id = $2), section_id = (SELECT id FROM sections WHERE id = $3) WHERE id = $1`,
        [u.id, u.faculty_id, u.section_id],
      );
    }
  });

  await cacheDel('stats');
  const counts = {
    rooms: d.rooms.length,
    faculty: d.faculty.length,
    sections: d.sections.length,
    courses: d.courses.length,
    offerings: d.offerings.length,
    baskets: d.baskets.length,
    rules: d.constraints.length,
  };
  audit(req.user, 'import', 'dataset', null, { file: req.file.originalname, name: d.name, ...counts });
  res.json({ imported: counts, name: d.name || null });
});

// Download everything as one dataset file (a backup, or to move data between installs).
datasetRouter.get('/', requireRole('admin', 'hod'), async (_req, res) => {
  const settings = await getSettings();
  if (!settings) throw badRequest('Set up days and periods in Settings first');
  const q = async (sql) => (await query(sql)).rows;
  const [rooms, faculty, canTeach, sections, courses, offerings, offSecs, baskets, basketSecs, options, cons] = await Promise.all([
    q('SELECT id, name, type, capacity, building FROM rooms ORDER BY id'),
    q('SELECT id, name, email, department, max_per_day, max_per_week FROM faculty ORDER BY id'),
    q('SELECT faculty_id, course_id FROM faculty_can_teach ORDER BY faculty_id, course_id'),
    q('SELECT id, name, program, semester, size FROM sections ORDER BY id'),
    q('SELECT id, code, name, type, sessions_per_week, department FROM courses ORDER BY id'),
    q('SELECT id, course_id, faculty_id, size, duration, sessions_per_week, max_sessions_per_day FROM offerings ORDER BY id'),
    q('SELECT offering_id, section_id FROM offering_sections ORDER BY offering_id, section_id'),
    q('SELECT id, name, sessions_per_week, duration, max_sessions_per_day FROM baskets ORDER BY id'),
    q('SELECT basket_id, section_id FROM basket_sections ORDER BY basket_id, section_id'),
    q('SELECT offering_id, basket_id, course_id, faculty_id, size FROM basket_options ORDER BY basket_id, offering_id'),
    q('SELECT subject_type, subject_id, kind, day, period_from, period_to, note FROM constraints ORDER BY id'),
  ]);
  const pick = (rows, key, val, k) => rows.filter((r) => r[key] === k).map((r) => r[val]);
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
  const { termStart, ...rest } = settings;
  const out = {
    format: DATASET_FORMAT,
    name: settings.institution,
    exportedAt: new Date().toISOString(),
    settings: { ...rest, ...(termStart ? { termStart: new Date(termStart).toISOString().slice(0, 10) } : {}) },
    rooms: rooms.map(clean),
    faculty: faculty.map((f) => clean({ id: f.id, name: f.name, email: f.email, department: f.department, maxPerDay: f.max_per_day, maxPerWeek: f.max_per_week, canTeach: pick(canTeach, 'faculty_id', 'course_id', f.id) })),
    sections: sections.map(clean),
    courses: courses.map((c) => clean({ id: c.id, code: c.code, name: c.name, type: c.type, sessionsPerWeek: c.sessions_per_week, department: c.department })),
    offerings: offerings.map((o) => clean({ id: o.id, courseId: o.course_id, facultyId: o.faculty_id, sectionIds: pick(offSecs, 'offering_id', 'section_id', o.id), size: o.size, duration: o.duration, sessionsPerWeek: o.sessions_per_week, maxSessionsPerDay: o.max_sessions_per_day })),
    baskets: baskets.map((b) => clean({
      id: b.id, name: b.name, sessionsPerWeek: b.sessions_per_week, duration: b.duration, maxSessionsPerDay: b.max_sessions_per_day,
      sectionIds: pick(basketSecs, 'basket_id', 'section_id', b.id),
      options: options.filter((o) => o.basket_id === b.id).map((o) => ({ offeringId: o.offering_id, courseId: o.course_id, facultyId: o.faculty_id, size: o.size })),
    })),
    constraints: cons.map((c) => clean({ subjectType: c.subject_type, subjectId: c.subject_id, kind: c.kind, day: c.day, periodFrom: c.period_from, periodTo: c.period_to, note: c.note })),
  };
  res.attachment('slotwise-dataset.json').type('application/json').send(JSON.stringify(out, null, 2));
});
