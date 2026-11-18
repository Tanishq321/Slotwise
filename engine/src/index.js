import { validateProblem, compileProblem, DEFAULT_CONFIG } from './problem.js';
import { State } from './state.js';
import { construct } from './construct.js';
import { anneal } from './anneal.js';
import { totalCost, WEIGHTS } from './cost.js';
import { createRng } from './rng.js';
import { checkTimetable } from './check.js';
import { suggestSubstitutes } from './substitutes.js';
import { applyMove, clashBaseline, findFreeRoom } from './move.js';

export { validateProblem, checkTimetable, suggestSubstitutes, applyMove, clashBaseline, findFreeRoom, WEIGHTS, DEFAULT_CONFIG };

/**
 * Generate a timetable.
 * @param {object} problem  see problem.js for the shape
 * @param {object} [opts]
 * @param {number} [opts.seed]            same seed + same input = same result
 * @param {number} [opts.timeLimitMs]     total time budget (construction + optimisation)
 * @param {number} [opts.optimiseShare]   fraction of the budget spent improving quality
 * @param {(p: object) => void} [opts.onProgress]
 */
export function generate(problem, opts = {}) {
  const { seed = Date.now() & 0x7fffffff, timeLimitMs = 8000, optimiseShare = 0.6, maxIters = Infinity, onProgress } = opts;
  const t0 = Date.now();
  const errors = validateProblem(problem);
  if (errors.length) return { status: 'invalid', errors, events: [], unplaced: [] };

  const c = compileProblem(problem);
  const rng = createRng(seed);
  const constructDeadline = t0 + timeLimitMs * (1 - optimiseShare);

  let state = new State(c);
  let built = construct(c, state, rng, { onProgress, deadline: constructDeadline });
  let restarts = 0;
  // Random restarts while time allows, keeping the attempt with the fewest unplaced classes.
  while (built.unplaced.length > 0 && Date.now() < constructDeadline) {
    restarts++;
    const fresh = new State(c);
    const attempt = construct(c, fresh, rng, { onProgress, deadline: constructDeadline });
    if (attempt.unplaced.length < built.unplaced.length) {
      state = fresh;
      built = attempt;
    }
  }
  const constructMs = Date.now() - t0;

  const remaining = Math.max(200, timeLimitMs - constructMs);
  // With maxIters set (tests), the result depends only on the seed, not on CPU speed.
  const opt = anneal(c, state, rng, { timeLimitMs: Number.isFinite(maxIters) ? Infinity : remaining, maxIters, onProgress });
  const { soft, breakdown } = totalCost(state);

  const events = c.events.map((ev, e) => ({
    id: ev.id,
    key: ev.key,
    kind: ev.kind,
    ...(ev.basketName ? { basketName: ev.basketName } : {}),
    duration: ev.duration,
    day: state.isPlaced(e) ? state.day[e] : null,
    start: state.isPlaced(e) ? state.start[e] : null,
    sectionIds: ev.groups.map((s) => c.sections[s].id),
    parts: ev.parts.map((part, i) => ({
      offeringId: part.offeringId,
      courseId: part.courseId,
      facultyId: c.faculty[part.facIdx].id,
      roomId: state.isPlaced(e) ? c.rooms[state.rooms[e][i]].id : null,
      size: part.size,
    })),
  }));
  const unplaced = built.unplaced.map((e) => ({
    eventId: c.events[e].id,
    reason: 'No clash-free slot found. Try freeing a teacher, adding a room, or relaxing a constraint.',
  }));
  onProgress?.({ phase: 'done', progress: 1 });

  return {
    status: unplaced.length ? 'partial' : 'ok',
    seed,
    events,
    unplaced,
    score: { hardViolations: 0, soft, breakdown },
    stats: {
      events: c.events.length,
      sections: c.S,
      faculty: c.F,
      rooms: c.R,
      restarts,
      constructSteps: built.steps,
      evictions: built.evictions,
      constructMs,
      optimiseMs: Date.now() - t0 - constructMs,
      iterations: opt.iterations,
      costBeforeOptimise: opt.initialCost,
      totalMs: Date.now() - t0,
    },
  };
}

/** Soft-score an existing timetable (e.g. after manual edits). Returns null if it has clashes. */
export function scoreTimetable(problem, events) {
  if (checkTimetable(problem, events).length) return null;
  const c = compileProblem(problem);
  const state = new State(c);
  const idx = new Map(c.events.map((e) => [e.id, e.idx]));
  for (const ev of events) {
    const e = idx.get(ev.id);
    if (e == null || ev.day == null) continue;
    const order = c.events[e].parts.map((p) => p.offeringId);
    const rooms = order.map((oid) => c.roomIdx.get(ev.parts.find((p) => p.offeringId === oid)?.roomId));
    state.place(e, ev.day, ev.start, rooms);
  }
  return totalCost(state);
}
