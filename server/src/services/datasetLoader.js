// Loads a whole Slotwise dataset (settings, rooms, teachers, classes, subjects, offerings,
// elective baskets, availability rules and, optionally, an official timetable) into the
// database. Used by the upload button, the built-in dataset button and the deploy-time
// loader in index.js.
//
// Import replaces ALL master data in one transaction. Users are kept. Nothing is written
// unless the file passes the zod schema and the engine's own validateProblem check, so a
// bad file can never leave half a dataset.
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { z } from 'zod';
import { checkTimetable, scoreTimetable, validateProblem } from '@slotwise/engine';
import { query, transaction } from '../db/pg.js';
import { AppError, badRequest } from '../utils/errors.js';
import { AuditLog, audit } from '../models/AuditLog.js';
import { Timetable } from '../models/Timetable.js';
import { cacheDel } from './redis.js';
import { buildProblemFromDb } from './problemBuilder.js';
import { settingsSchema } from '../routes/settings.js';
import { DEMO_USERS } from '../db/seed.js';
import { logger } from '../utils/logger.js';

export const DATASET_FORMAT = 'slotwise-dataset/1';

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
  sections: z
    .array(z.object({ id, name: z.string().trim().min(1).max(60), program: optText, semester: z.number().int().min(1).max(12).nullish(), size: z.number().int().min(1).max(5000), homeRoomId: id.nullish() }))
    .max(2000),
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
  // The timetable the institution actually uses, slot by slot (optional).
  official: z
    .object({
      name: z.string().trim().min(1).max(120),
      events: z
        .array(
          z.object({
            id,
            key: id,
            kind: z.enum(['offering', 'basket']),
            basketName: z.string().max(200).optional(),
            duration: z.number().int().min(1).max(6),
            day: z.number().int().min(0),
            start: z.number().int().min(0),
            sectionIds: ids(40).min(1),
            parts: z.array(z.object({ offeringId: id, courseId: id, facultyId: id, roomId: id, size: z.number().int().min(0).max(5000) })).min(1).max(20),
          }),
        )
        .max(20000),
    })
    .optional(),
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
  const roomIds = new Set(d.rooms.map((r) => r.id));
  for (const s of d.sections) if (s.homeRoomId && !roomIds.has(s.homeRoomId)) errors.push({ code: 'UNKNOWN_REF', message: `${s.name} has an unknown home room "${s.homeRoomId}"` });
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

export const parseJson = (buffer) => {
  try {
    return JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw badRequest(`The file is not valid JSON: ${err.message}`);
  }
};

// Datasets shipped with the app in server/data/ (e.g. the real Chitkara CSE-AI data).
export const BUNDLED_DIR = new URL('../../data/', import.meta.url);
export const bundledFile = async (name) => {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const files = await readdir(BUNDLED_DIR).catch(() => []);
  return files.includes(`${name}.json`) ? new URL(`${name}.json`, BUNDLED_DIR) : null;
};

/**
 * Demo logins are linked to a demo class and teacher. After a new dataset they point
 * nowhere, so link them to the first class (by name) and a teacher of that class.
 */
async function relinkDemoUsers(c) {
  const student = DEMO_USERS.find((u) => u.role === 'student').email;
  const teacher = DEMO_USERS.find((u) => u.role === 'faculty').email;
  const sec = (await c.query('SELECT id FROM sections ORDER BY name LIMIT 1')).rows[0];
  if (!sec) return;
  await c.query('UPDATE users SET section_id = $1 WHERE lower(email) = $2 AND section_id IS NULL', [sec.id, student]);
  const fac = (
    await c.query(
      `SELECT o.faculty_id AS id FROM offerings o JOIN offering_sections os ON os.offering_id = o.id
       WHERE os.section_id = $1 ORDER BY o.id LIMIT 1`,
      [sec.id],
    )
  ).rows[0];
  if (fac) await c.query('UPDATE users SET faculty_id = $1 WHERE lower(email) = $2 AND faculty_id IS NULL', [fac.id, teacher]);
  // The demo teacher login takes the name of the teacher it is linked to.
  await c.query('UPDATE users u SET name = f.name FROM faculty f WHERE u.faculty_id = f.id AND lower(u.email) = $1', [teacher]);
}

/** Saves the dataset's official timetable as a finished version (optionally published). */
async function saveOfficial(official, user, publish) {
  const problem = await buildProblemFromDb();
  const known = new Set([...problem.offerings.map((o) => o.id), ...problem.baskets.map((b) => b.id)]);
  const unknown = official.events.find((e) => !known.has(e.key));
  if (unknown) throw badRequest(`The official timetable mentions "${unknown.key}", which is not in the dataset`);
  const clashes = checkTimetable(problem, official.events);
  const score = clashes.length ? null : scoreTimetable(problem, official.events);
  if (publish) await Timetable.updateMany({ published: true }, { published: false });
  const tt = await Timetable.create({
    name: official.name,
    status: 'done',
    progress: { phase: 'done', percent: 100, message: 'Loaded from the official timetable' },
    seed: 0,
    events: official.events,
    unplaced: [],
    score: { hardViolations: clashes.length, ...(score || {}) },
    stats: { source: 'official', events: official.events.length },
    problem,
    published: !!publish,
    publishedAt: publish ? new Date() : undefined,
    createdBy: { id: user?.id ?? 0, name: user?.name || 'Slotwise' },
  });
  await cacheDel('timetable:published', 'stats');
  return { id: tt.id, name: tt.name, clashes: clashes.length, published: !!publish };
}

/**
 * Validates and imports a dataset. options.official: 'skip' | 'draft' | 'publish' decides
 * what happens to the dataset's official timetable, if it has one.
 */
export async function importDataset(raw, user, label, { official = 'skip' } = {}) {
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
    await bulkInsert(c, 'sections', ['id', 'name', 'program', 'semester', 'size', 'home_room_id'], ['text', 'text', 'text', 'int', 'int', 'text'],
      d.sections.map((x) => ({ ...x, home_room_id: x.homeRoomId })));
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
    await relinkDemoUsers(c);
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
  const officialVersion = d.official && official !== 'skip' ? await saveOfficial(d.official, user, official === 'publish') : null;
  audit(user, 'import', 'dataset', null, { file: label, name: d.name, ...counts, official: officialVersion?.name });
  return { imported: counts, name: d.name || null, official: officialVersion };
}

/**
 * Deploy-time reset (hosts like Render's free plan have no terminal). When LOAD_DATASET
 * names a built-in dataset, the first start after that file changes:
 *   1. deletes every timetable version and the audit log from MongoDB,
 *   2. replaces all master data in PostgreSQL with the dataset (logins are kept),
 *   3. saves the dataset's official timetable and publishes it.
 * The file's hash is remembered, so later restarts (free instances sleep often) do nothing.
 */
export async function loadDatasetOnDeploy(name) {
  const file = await bundledFile(name);
  if (!file) {
    logger.warn(`LOAD_DATASET=${name}, but server/data/${name}.json does not exist; skipping`);
    return null;
  }
  const buffer = await readFile(file);
  const hash = createHash('sha256').update(buffer).digest('hex');
  const key = `dataset:${name}`;
  const done = await query('SELECT value FROM app_state WHERE key = $1', [key]);
  if (done.rows[0]?.value === hash) {
    logger.info(`Dataset ${name} is already loaded; skipping`);
    return null;
  }

  logger.info(`Loading dataset ${name}: clearing old timetables and replacing all data`);
  const [tts, logs] = await Promise.all([Timetable.deleteMany({}), AuditLog.deleteMany({})]);
  const result = await importDataset(parseJson(buffer), null, `${name}.json (deploy)`, { official: 'publish' });
  await cacheDel('timetable:published', 'stats');
  await query('INSERT INTO app_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()', [key, hash]);
  logger.info(`Dataset ${name} loaded`, { removedTimetables: tts.deletedCount, removedAuditEntries: logs.deletedCount, ...result.imported, official: result.official });
  return result;
}
