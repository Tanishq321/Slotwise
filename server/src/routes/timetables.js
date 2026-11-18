// Timetable versions: generate (queued job), watch progress (Server-Sent Events),
// view, edit by drag-and-drop, compare, publish, analytics, substitutes and .ics export.
import { Router } from 'express';
import { z } from 'zod';
import { validateProblem, checkTimetable, suggestSubstitutes } from '@samay/engine';
import { Timetable } from '../models/Timetable.js';
import { audit } from '../models/AuditLog.js';
import { canEdit } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { env } from '../config/env.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../utils/errors.js';
import { buildProblemFromDb, getSettings } from '../services/problemBuilder.js';
import { enqueueGeneration } from '../services/queue.js';
import { cacheDel, cacheGet, cacheSet, rateLimit } from '../services/redis.js';
import { applyMove, filterEvents } from '../services/timetableEdit.js';
import { buildIcs } from '../services/ics.js';
import { timetableAnalytics } from '../services/analytics.js';

export const timetablesRouter = Router();

const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid timetable id');
const idParam = z.object({ id: objectId });
const isEditor = (user) => ['admin', 'hod'].includes(user.role);
const SUMMARY = '-events -problem';

async function loadForUser(id, user, { lean = false } = {}) {
  const q = Timetable.findById(id);
  const tt = lean ? await q.lean() : await q;
  if (!tt) throw notFound('Timetable');
  // Students and faculty only ever see the published timetable.
  if (!isEditor(user) && !tt.published) throw forbidden('This timetable has not been published yet');
  return tt;
}

const invalidate = (id) => cacheDel(`timetable:${id}`, 'timetable:published', 'stats');

// ---------- pre-flight check & generation ----------

/** Summarises the current master data and lists anything that would stop generation. */
timetablesRouter.get('/preflight', canEdit, async (_req, res) => {
  const problem = await buildProblemFromDb();
  if (!problem.config) return res.json({ ok: false, errors: [{ code: 'CONFIG', message: 'Set up days and periods in Settings first' }], summary: null });
  const errors = validateProblem(problem);
  const labDuration = problem.config.labDuration;
  const classes =
    problem.offerings.reduce((n, o) => n + (problem.courses.find((c) => c.id === o.courseId)?.sessionsPerWeek || 0), 0) +
    problem.baskets.reduce((n, b) => n + b.sessionsPerWeek, 0);
  const periods =
    problem.offerings.reduce((n, o) => {
      const c = problem.courses.find((x) => x.id === o.courseId);
      return n + (c ? c.sessionsPerWeek * (c.type === 'lab' ? labDuration : 1) : 0);
    }, 0) + problem.baskets.reduce((n, b) => n + b.sessionsPerWeek, 0);
  res.json({
    ok: errors.length === 0,
    errors,
    summary: {
      faculty: problem.faculty.length,
      rooms: problem.rooms.length,
      sections: problem.sections.length,
      courses: problem.courses.length,
      offerings: problem.offerings.length,
      baskets: problem.baskets.length,
      classesPerWeek: classes,
      periodsPerWeek: periods,
      rules: problem.faculty.reduce((n, f) => n + f.unavailable.length + f.avoid.length, 0) + problem.sections.reduce((n, s) => n + s.unavailable.length, 0),
    },
  });
});

const generateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  timeLimitSec: z.number().int().min(2).max(120).optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
});

timetablesRouter.post('/', canEdit, validate({ body: generateSchema }), async (req, res) => {
  const rl = await rateLimit(`generate:${req.user.id}`, env.NODE_ENV === 'test' ? 1000 : 15, 600);
  if (!rl.allowed) throw new AppError(429, `Generation limit reached, try again in ${rl.resetIn}s`);
  const problem = await buildProblemFromDb();
  if (!problem.config) throw badRequest('Set up days and periods in Settings first');
  // Catch impossible input now (fast, clear errors) instead of in the background job.
  const errors = validateProblem(problem);
  if (errors.length) throw new AppError(422, 'Fix these problems before generating', { errors });

  const count = await Timetable.countDocuments();
  const tt = await Timetable.create({
    name: req.valid.body.name || `Version ${count + 1}`,
    status: 'queued',
    seed: req.valid.body.seed ?? Math.floor(Math.random() * 2_147_483_647),
    timeLimitSec: req.valid.body.timeLimitSec ?? env.GENERATION_TIME_LIMIT_SEC,
    problem,
    createdBy: { id: req.user.id, name: req.user.name },
    progress: { phase: 'queued', percent: 0, message: 'Waiting for a worker…' },
  });
  await enqueueGeneration(tt.id);
  await cacheDel('stats');
  audit(req.user, 'generate', 'timetable', tt.id, { name: tt.name, seed: tt.seed });
  res.status(202).json({ id: tt.id, name: tt.name, status: tt.status });
});

// ---------- listing ----------

timetablesRouter.get(
  '/',
  canEdit,
  validate({ query: z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), status: z.enum(['queued', 'running', 'done', 'failed']).optional() }) }),
  async (req, res) => {
    const { page, limit, status } = req.valid.query;
    const filter = status ? { status } : {};
    const [items, total] = await Promise.all([
      Timetable.find(filter).select(SUMMARY).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Timetable.countDocuments(filter),
    ]);
    res.json({ items: items.map(({ _id, ...t }) => ({ id: String(_id), ...t })), total, page, limit, pages: Math.ceil(total / limit) });
  },
);

/** The timetable currently in force — what students and faculty see. */
timetablesRouter.get('/published', async (_req, res) => {
  const cached = await cacheGet('timetable:published');
  if (cached) return res.set('X-Cache', 'HIT').json(cached);
  const tt = await Timetable.findPublished();
  if (!tt) throw notFound('Published timetable');
  const json = tt.toJSON();
  await cacheSet('timetable:published', json, 600);
  res.set('X-Cache', 'MISS').json(json);
});

/** Side-by-side comparison of two versions. */
timetablesRouter.get('/compare', canEdit, validate({ query: z.object({ a: objectId, b: objectId }) }), async (req, res) => {
  const [a, b] = await Promise.all([Timetable.findById(req.valid.query.a).lean(), Timetable.findById(req.valid.query.b).lean()]);
  if (!a || !b) throw notFound('Timetable');
  if (a.status !== 'done' || b.status !== 'done') throw badRequest('Both versions must be finished generating');
  const bById = new Map(b.events.map((e) => [e.id, e]));
  const moved = [];
  let same = 0;
  for (const e of a.events) {
    const o = bById.get(e.id);
    if (!o) continue;
    if (o.day === e.day && o.start === e.start) same++;
    else moved.push({ id: e.id, from: { day: e.day, start: e.start }, to: { day: o.day, start: o.start } });
  }
  const pick = (t) => ({ id: String(t._id), name: t.name, score: t.score, stats: t.stats, unplaced: t.unplaced.length, published: t.published, createdAt: t.createdAt });
  res.json({
    a: pick(a),
    b: pick(b),
    sameSlot: same,
    moved: moved.length,
    movedEvents: moved.slice(0, 500),
    softDiff: Math.round(((b.score?.soft ?? 0) - (a.score?.soft ?? 0)) * 10) / 10,
  });
});

// ---------- one version ----------

timetablesRouter.get('/:id', validate({ params: idParam }), async (req, res) => {
  const { id } = req.valid.params;
  const cached = await cacheGet(`timetable:${id}`);
  if (cached && (isEditor(req.user) || cached.published)) return res.set('X-Cache', 'HIT').json(cached);
  const tt = await loadForUser(id, req.user);
  const json = tt.toJSON();
  if (tt.status === 'done') await cacheSet(`timetable:${id}`, json, 600);
  res.set('X-Cache', 'MISS').json(json);
});

/**
 * Live progress as Server-Sent Events (a long-lived HTTP response that we keep
 * writing to). The client reads it with fetch() + a stream reader.
 */
timetablesRouter.get('/:id/progress', canEdit, validate({ params: idParam }), async (req, res) => {
  const { id } = req.valid.params;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  let last = '';
  let closed = false;
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const tick = async () => {
    if (closed) return;
    const tt = await Timetable.findById(id).select('name status progress error validationErrors stats score unplaced').lean();
    if (!tt) {
      send('error', { error: 'Timetable not found' });
      return finish();
    }
    const payload = { status: tt.status, progress: tt.progress, error: tt.error, validationErrors: tt.validationErrors, stats: tt.stats, score: tt.score, unplaced: tt.unplaced?.length };
    const json = JSON.stringify(payload);
    if (json !== last) {
      last = json;
      send('progress', payload);
    }
    if (tt.status === 'done' || tt.status === 'failed') finish();
  };
  const timer = setInterval(() => tick().catch(() => finish()), 400);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  function finish() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearInterval(keepAlive);
    res.end();
  }
  req.on('close', finish);
  await tick();
});

timetablesRouter.patch('/:id', canEdit, validate({ params: idParam, body: z.object({ name: z.string().trim().min(1).max(120) }) }), async (req, res) => {
  const tt = await Timetable.findByIdAndUpdate(req.valid.params.id, { name: req.valid.body.name }, { new: true }).select(SUMMARY);
  if (!tt) throw notFound('Timetable');
  await invalidate(tt.id);
  audit(req.user, 'rename', 'timetable', tt.id, req.valid.body);
  res.json(tt.toJSON());
});

const moveSchema = z.object({
  day: z.number().int().min(0).max(6),
  start: z.number().int().min(0).max(15),
  rooms: z.record(z.string(), z.string().trim().min(1)).optional(),
  force: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

/** Move one class. Clashes → 409 with details, unless force=true. dryRun only checks. */
timetablesRouter.patch('/:id/events/:eventId', canEdit, validate({ params: z.object({ id: objectId, eventId: z.string().min(1).max(80) }), body: moveSchema }), async (req, res) => {
  const { id, eventId } = req.valid.params;
  const { force, dryRun, ...move } = req.valid.body;
  const tt = await Timetable.findById(id);
  if (!tt) throw notFound('Timetable');
  if (tt.status !== 'done') throw badRequest('This version is still generating');
  const result = applyMove(tt.problem, tt.events, eventId, move);
  if (!result) throw notFound('Class');
  if (dryRun) return res.json({ ok: result.newClashes.length === 0, clashes: result.newClashes, moved: result.moved, score: result.score });
  if (result.newClashes.length && !force) throw conflict('That move would create a clash', { clashes: result.newClashes });

  const i = tt.events.findIndex((e) => e.id === eventId);
  tt.events.set(i, result.moved);
  tt.editCount += 1;
  tt.unplaced = tt.unplaced.filter((u) => u.eventId !== eventId);
  tt.score = { hardViolations: result.allClashes.length, ...(result.score ? { soft: result.score.soft, breakdown: result.score.breakdown } : { soft: tt.score?.soft, breakdown: tt.score?.breakdown }) };
  await tt.save();
  await invalidate(id);
  audit(req.user, force && result.newClashes.length ? 'force-move' : 'move', 'timetable', id, { eventId, ...move, clashes: result.newClashes.length });
  res.json({ ok: true, event: result.moved, score: tt.score, clashes: result.newClashes });
});

timetablesRouter.post('/:id/publish', canEdit, validate({ params: idParam }), async (req, res) => {
  const tt = await Timetable.findById(req.valid.params.id);
  if (!tt) throw notFound('Timetable');
  if (tt.status !== 'done') throw badRequest('Only finished timetables can be published');
  const clashes = checkTimetable(tt.problem, tt.events).filter((c) => c.type !== 'unplaced');
  if (clashes.length) throw conflict(`Fix ${clashes.length} clash(es) before publishing`, { clashes: clashes.slice(0, 50) });
  await Timetable.updateMany({ published: true }, { published: false });
  tt.published = true;
  tt.publishedAt = new Date();
  await tt.save();
  await cacheDel('timetable:published', `timetable:${tt.id}`, 'stats');
  audit(req.user, 'publish', 'timetable', tt.id, { name: tt.name });
  res.json({ ok: true, id: tt.id, publishedAt: tt.publishedAt, unplaced: tt.unplaced.length });
});

timetablesRouter.delete('/:id', canEdit, validate({ params: idParam }), async (req, res) => {
  const tt = await Timetable.findById(req.valid.params.id).select('published status');
  if (!tt) throw notFound('Timetable');
  if (tt.published) throw conflict('Publish another version before deleting the published one');
  if (tt.status === 'queued' || tt.status === 'running') throw conflict('Wait for generation to finish before deleting');
  await tt.deleteOne();
  await invalidate(req.valid.params.id);
  audit(req.user, 'delete', 'timetable', req.valid.params.id);
  res.status(204).end();
});

// ---------- tools ----------

timetablesRouter.get(
  '/:id/substitutes',
  canEdit,
  validate({ params: idParam, query: z.object({ facultyId: z.string().trim().min(1), day: z.coerce.number().int().min(0).max(6) }) }),
  async (req, res) => {
    const tt = await Timetable.findById(req.valid.params.id).lean();
    if (!tt) throw notFound('Timetable');
    const { facultyId, day } = req.valid.query;
    if (!tt.problem.faculty.some((f) => f.id === facultyId)) throw notFound('Faculty member');
    res.json({ items: suggestSubstitutes(tt.problem, tt.events, facultyId, day) });
  },
);

/** Faculty load, room utilisation and classes per day (see services/analytics.js). */
timetablesRouter.get('/:id/analytics', canEdit, validate({ params: idParam }), async (req, res) => {
  const result = await timetableAnalytics(req.valid.params.id);
  if (!result) throw notFound('Timetable');
  res.json(result);
});

/** Download a section's, teacher's or room's timetable as an .ics calendar file. */
timetablesRouter.get(
  '/:id/ics',
  validate({ params: idParam, query: z.object({ type: z.enum(['section', 'faculty', 'room']), id: z.string().trim().min(1) }) }),
  async (req, res) => {
    const tt = await loadForUser(req.valid.params.id, req.user, { lean: true });
    const { type, id } = req.valid.query;
    const list = { section: tt.problem.sections, faculty: tt.problem.faculty, room: tt.problem.rooms }[type];
    const subject = list.find((x) => x.id === id);
    if (!subject) throw notFound(type);
    if (!tt.problem.config.periodTimes?.length) throw badRequest('Add period start/end times in Settings to export a calendar');
    const settings = await getSettings();
    const ics = buildIcs({ title: `${subject.name} — ${tt.name}`, problem: tt.problem, events: filterEvents(tt.events, type, id), termStart: settings?.termStart, termWeeks: settings?.termWeeks });
    res.type('text/calendar').attachment(`${subject.name.replace(/[^\w-]+/g, '_')}.ics`).send(ics);
  },
);
