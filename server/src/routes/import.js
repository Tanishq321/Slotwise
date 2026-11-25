// Bulk CSV import (Multer upload → csv-parse → zod validation → one transaction).
// All-or-nothing: if any row is invalid, nothing is saved and every bad row is reported
// with its line number, so the admin can fix the spreadsheet and upload it again.
import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { transaction } from '../db/pg.js';
import { canEdit } from '../middleware/auth.js';
import { badRequest, AppError } from '../utils/errors.js';
import { newId } from '../utils/ids.js';
import { audit } from '../models/AuditLog.js';
import { cacheDel } from '../services/redis.js';

export const importRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(), // files are small; never touch the disk
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.csv$/i.test(file.originalname) || ['text/csv', 'application/vnd.ms-excel', 'text/plain'].includes(file.mimetype);
    cb(ok ? null : badRequest('Please upload a .csv file'), ok);
  },
});

const blankToUndef = (v) => (v === '' || v == null ? undefined : v);
const int = (min, max) => z.preprocess(blankToUndef, z.coerce.number().int().min(min).max(max));
const optInt = (min, max) => z.preprocess(blankToUndef, z.coerce.number().int().min(min).max(max).optional());
const str = (max = 120) => z.string().trim().min(1).max(max);
const optStr = (max = 120) => z.preprocess(blankToUndef, z.string().trim().max(max).optional());
const list = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() ? v.split(/[;|]/).map((x) => x.trim()).filter(Boolean) : []),
  z.array(z.string()),
);

// For each entity: the CSV columns, how to find an existing row (so re-importing
// updates instead of duplicating), and how to write it.
const ENTITIES = {
  rooms: {
    columns: ['name', 'type', 'capacity', 'building'],
    example: ['LT-101', 'lecture', '72', 'Block A'],
    schema: z.object({ name: str(60), type: z.enum(['lecture', 'lab']), capacity: int(1, 2000), building: optStr(80) }),
    async save(c, r) {
      const id = (await c.query('SELECT id FROM rooms WHERE lower(name) = lower($1)', [r.name])).rows[0]?.id || newId('room');
      await c.query(
        `INSERT INTO rooms (id, name, type, capacity, building) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET name=$2, type=$3, capacity=$4, building=$5`,
        [id, r.name, r.type, r.capacity, r.building ?? null],
      );
    },
  },
  sections: {
    columns: ['name', 'program', 'semester', 'size', 'home_room'],
    example: ['CSE 5-A', 'B.E. CSE', '5', '62', 'LT-101'],
    schema: z.object({ name: str(60), program: optStr(80), semester: optInt(1, 12), size: int(1, 2000), home_room: optStr(60) }),
    async save(c, r) {
      const id = (await c.query('SELECT id FROM sections WHERE lower(name) = lower($1)', [r.name])).rows[0]?.id || newId('sec');
      const home = r.home_room ? (await c.query('SELECT id FROM rooms WHERE lower(name) = lower($1)', [r.home_room])).rows[0] : null;
      if (r.home_room && !home) throw new Error(`unknown room "${r.home_room}"`);
      await c.query(
        `INSERT INTO sections (id, name, program, semester, size, home_room_id) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET name=$2, program=$3, semester=$4, size=$5, home_room_id=COALESCE($6, sections.home_room_id)`,
        [id, r.name, r.program ?? null, r.semester ?? null, r.size, home?.id ?? null],
      );
    },
  },
  courses: {
    columns: ['code', 'name', 'type', 'sessions_per_week', 'department'],
    example: ['24CS0305', 'Back End Engineering-II', 'lab', '4', 'CSE'],
    schema: z.object({ code: str(30), name: str(), type: z.enum(['lecture', 'lab']), sessions_per_week: int(1, 10), department: optStr(80) }),
    async save(c, r) {
      const id = (await c.query('SELECT id FROM courses WHERE lower(code) = lower($1)', [r.code])).rows[0]?.id || newId('crs');
      await c.query(
        `INSERT INTO courses (id, code, name, type, sessions_per_week, department) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET code=$2, name=$3, type=$4, sessions_per_week=$5, department=$6`,
        [id, r.code, r.name, r.type, r.sessions_per_week, r.department ?? null],
      );
    },
  },
  faculty: {
    columns: ['name', 'email', 'department', 'max_per_day', 'max_per_week', 'can_teach'],
    example: ['Dr. Anjali Sharma', 'anjali.sharma@example.edu', 'CSE', '4', '18', '24CS0305;24CS0301'],
    schema: z.object({
      name: str(),
      email: z.preprocess(blankToUndef, z.string().trim().toLowerCase().pipe(z.email()).optional()),
      department: optStr(80),
      max_per_day: optInt(1, 12),
      max_per_week: optInt(1, 60),
      can_teach: list,
    }),
    async save(c, r) {
      const existing = r.email
        ? await c.query('SELECT id FROM faculty WHERE lower(email) = $1', [r.email])
        : await c.query('SELECT id FROM faculty WHERE lower(name) = lower($1)', [r.name]);
      const id = existing.rows[0]?.id || newId('fac');
      await c.query(
        `INSERT INTO faculty (id, name, email, department, max_per_day, max_per_week) VALUES ($1,$2,$3,$4,COALESCE($5,4),COALESCE($6,18))
         ON CONFLICT (id) DO UPDATE SET name=$2, email=$3, department=$4,
           max_per_day=COALESCE($5, faculty.max_per_day), max_per_week=COALESCE($6, faculty.max_per_week)`,
        [id, r.name, r.email ?? null, r.department ?? null, r.max_per_day ?? null, r.max_per_week ?? null],
      );
      if (r.can_teach.length) {
        const found = await c.query('SELECT id, code FROM courses WHERE lower(code) = ANY($1)', [r.can_teach.map((x) => x.toLowerCase())]);
        if (found.rowCount !== new Set(r.can_teach.map((x) => x.toLowerCase())).size) throw new Error('can_teach lists a course code that does not exist');
        await c.query('DELETE FROM faculty_can_teach WHERE faculty_id = $1', [id]);
        for (const row of found.rows) await c.query('INSERT INTO faculty_can_teach (faculty_id, course_id) VALUES ($1,$2)', [id, row.id]);
      }
    },
  },
  offerings: {
    columns: ['course_code', 'faculty', 'sections', 'size', 'class_length', 'sessions_per_week', 'max_per_day'],
    example: ['24CS0305', 'anjali.sharma@example.edu', 'CSE 5-A;CSE 5-B', '', '', '', ''],
    schema: z.object({
      course_code: str(30),
      faculty: str(),
      sections: list.pipe(z.array(z.string()).min(1, 'list at least one section')),
      size: optInt(1, 2000),
      class_length: optInt(1, 6),
      sessions_per_week: optInt(1, 10),
      max_per_day: optInt(1, 6),
    }),
    async save(c, r) {
      const course = (await c.query('SELECT id FROM courses WHERE lower(code) = lower($1)', [r.course_code])).rows[0];
      if (!course) throw new Error(`unknown course code "${r.course_code}"`);
      const fac = (await c.query('SELECT id FROM faculty WHERE lower(email) = lower($1) OR lower(name) = lower($1) OR id = $1', [r.faculty])).rows;
      if (fac.length !== 1) throw new Error(fac.length ? `"${r.faculty}" matches several teachers, use their email` : `unknown teacher "${r.faculty}"`);
      const secs = await c.query('SELECT id, name FROM sections WHERE lower(name) = ANY($1)', [r.sections.map((s) => s.toLowerCase())]);
      if (secs.rowCount !== r.sections.length) throw new Error('one of the sections does not exist');
      const id = newId('off');
      await c.query(
        'INSERT INTO offerings (id, course_id, faculty_id, size, duration, sessions_per_week, max_sessions_per_day) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, course.id, fac[0].id, r.size ?? null, r.class_length ?? null, r.sessions_per_week ?? null, r.max_per_day ?? null],
      );
      for (const s of secs.rows) await c.query('INSERT INTO offering_sections (offering_id, section_id) VALUES ($1,$2)', [id, s.id]);
    },
  },
};

const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

// Download an empty template with the right headers and one example row.
importRouter.get('/:entity/template', (req, res) => {
  const def = ENTITIES[req.params.entity];
  if (!def) throw badRequest(`Unknown import type. Use one of: ${Object.keys(ENTITIES).join(', ')}`);
  res.type('text/csv').attachment(`slotwise-${req.params.entity}-template.csv`);
  res.send(`${def.columns.join(',')}\n${def.example.map(csvCell).join(',')}\n`);
});

importRouter.post('/:entity', canEdit, upload.single('file'), async (req, res) => {
  const def = ENTITIES[req.params.entity];
  if (!def) throw badRequest(`Unknown import type. Use one of: ${Object.keys(ENTITIES).join(', ')}`);
  if (!req.file) throw badRequest('Attach a CSV file in the "file" field');

  let records;
  try {
    records = parse(req.file.buffer, { columns: (h) => h.map((x) => x.trim().toLowerCase().replace(/\s+/g, '_')), skip_empty_lines: true, trim: true, bom: true });
  } catch (err) {
    throw badRequest(`Could not read the CSV: ${err.message}`);
  }
  if (!records.length) throw badRequest('The file has no data rows');
  if (records.length > 5000) throw badRequest('Import at most 5000 rows at a time');
  const missing = def.columns.filter((c) => def.schema.shape[c] && !(def.schema.shape[c].safeParse(undefined).success) && !(c in records[0]));
  if (missing.length) throw badRequest(`Missing column(s): ${missing.join(', ')}. Download the template to see the expected format.`);

  // 1) Validate every row first.
  const errors = [];
  const valid = [];
  records.forEach((rec, i) => {
    const r = def.schema.safeParse(rec);
    if (r.success) valid.push({ line: i + 2, row: r.data });
    else errors.push({ line: i + 2, errors: r.error.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`) });
  });
  if (errors.length) throw new AppError(422, `${errors.length} row(s) have problems — nothing was imported`, { rows: errors.slice(0, 100) });

  // 2) Save in one transaction; a database-level problem also rolls everything back.
  await transaction(async (client) => {
    for (const { line, row } of valid) {
      try {
        await def.save(client, row);
      } catch (err) {
        throw new AppError(422, `Line ${line}: ${err.message} — nothing was imported`, { rows: [{ line, errors: [err.message] }] });
      }
    }
  });
  await cacheDel('stats');
  audit(req.user, 'import', req.params.entity, null, { rows: valid.length, file: req.file.originalname });
  res.json({ imported: valid.length, entity: req.params.entity });
});
