// Whole-dataset import/export (one JSON file with settings, rooms, teachers, classes,
// subjects, offerings, elective baskets and availability rules).
//
// Import replaces ALL master data in one transaction. Users and saved timetable
// versions are kept. Nothing is written unless the file passes the zod schema and the
// engine's own validateProblem check, so a bad file can never leave half a dataset.
import { readFile, readdir } from 'node:fs/promises';
import { Router } from 'express';
import multer from 'multer';
import { query } from '../db/pg.js';
import { requireRole } from '../middleware/auth.js';
import { badRequest } from '../utils/errors.js';
import { getSettings } from '../services/problemBuilder.js';
import { DATASET_FORMAT, BUNDLED_DIR, bundledFile, importDataset, parseJson } from '../services/datasetLoader.js';

export const datasetRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.json$/i.test(file.originalname) || file.mimetype === 'application/json';
    cb(ok ? null : badRequest('Please upload a .json dataset file'), ok);
  },
});



datasetRouter.post('/', requireRole('admin'), upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Attach the dataset .json file in the "file" field');
  res.json(await importDataset(parseJson(req.file.buffer), req.user, req.file.originalname));
});

// Datasets shipped with the app in server/data/ (e.g. the real Chitkara CSE-AI data),
// so they can be loaded from the browser without downloading and re-uploading a file.

datasetRouter.get('/bundled', requireRole('admin', 'hod'), async (_req, res) => {
  const files = (await readdir(BUNDLED_DIR).catch(() => [])).filter((f) => f.endsWith('.json'));
  const items = [];
  for (const f of files) {
    const d = parseJson(await readFile(new URL(f, BUNDLED_DIR)));
    if (d.format !== DATASET_FORMAT) continue;
    items.push({ id: f.replace(/\.json$/, ''), name: d.name || f, sections: d.sections?.length || 0, faculty: d.faculty?.length || 0, rooms: d.rooms?.length || 0 });
  }
  res.json({ items });
});

datasetRouter.post('/bundled/:id', requireRole('admin'), async (req, res) => {
  const file = await bundledFile(req.params.id);
  if (!file) throw badRequest('No built-in dataset with that name');
  res.json(await importDataset(parseJson(await readFile(file)), req.user, `${req.params.id}.json (built-in)`, { official: 'draft' }));
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
