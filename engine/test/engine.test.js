import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate, validateProblem, checkTimetable, suggestSubstitutes, scoreTimetable } from '../src/index.js';
import { buildProblem } from '../data/build-problem.js';

const fast = { seed: 7, maxIters: 40000, timeLimitMs: 60000 };
const sample = () => buildProblem({ sectionCount: 8 });

test('sample department: every class placed with zero clashes', () => {
  const problem = sample();
  const result = generate(problem, fast);
  assert.equal(result.status, 'ok');
  assert.equal(result.unplaced.length, 0);
  assert.ok(result.events.every((e) => e.day !== null));
  assert.deepEqual(checkTimetable(problem, result.events), []);
});

test('same seed gives the same timetable', () => {
  const problem = sample();
  const a = generate(problem, fast);
  const b = generate(problem, fast);
  assert.deepEqual(
    a.events.map((e) => [e.id, e.day, e.start, e.parts.map((p) => p.roomId)]),
    b.events.map((e) => [e.id, e.day, e.start, e.parts.map((p) => p.roomId)]),
  );
});

test('optimisation lowers the soft cost', () => {
  const problem = sample();
  const result = generate(problem, { ...fast, maxIters: 200000 });
  assert.ok(result.score.soft < result.stats.costBeforeOptimise, `${result.score.soft} should be < ${result.stats.costBeforeOptimise}`);
});

test('hard rules: breaks, availability, lab rooms, electives in parallel', () => {
  const problem = sample();
  const { events } = generate(problem, fast);
  const fac0 = problem.faculty[0];
  for (const ev of events) {
    for (let p = ev.start; p < ev.start + ev.duration; p++) {
      assert.notEqual(p, 4, 'nothing in the lunch break');
      if (ev.sectionIds.length && ev.day === 2) assert.notEqual(p, 7, 'Wednesday last period is reserved');
      if (ev.parts.some((x) => x.facultyId === fac0.id) && ev.day === 2) assert.ok(p < 5, `${fac0.name} is away Wed afternoon`);
    }
    for (const part of ev.parts) {
      const course = problem.courses.find((c) => c.id === part.courseId);
      const room = problem.rooms.find((r) => r.id === part.roomId);
      assert.equal(room.type, course.type === 'lab' ? 'lab' : 'lecture');
    }
    if (ev.kind === 'basket') {
      const rooms = ev.parts.map((p) => p.roomId);
      assert.equal(new Set(rooms).size, rooms.length, 'each elective option gets its own room');
      assert.equal(ev.sectionIds.length, 4);
    }
  }
  const labs = events.filter((e) => e.key.startsWith('off-bee2-lab'));
  assert.ok(labs.every((e) => e.duration === 2));
});

test('a course does not meet twice on the same day when it can be spread out', () => {
  const problem = sample();
  const { events } = generate(problem, fast);
  const seen = new Set();
  for (const ev of events) {
    const k = `${ev.key}|${ev.day}`;
    assert.ok(!seen.has(k), `${ev.key} twice on day ${ev.day}`);
    seen.add(k);
  }
});

test('validateProblem catches impossible inputs', () => {
  const problem = sample();
  problem.faculty[0].maxPerWeek = 4;
  problem.offerings.push({ id: 'bad', courseId: 'nope', facultyId: 'fac-001', sectionIds: ['sec-a'] });
  problem.offerings.push({ id: 'bad2', courseId: 'ps', facultyId: 'fac-001', sectionIds: ['sec-zz'] });
  const codes = validateProblem(problem).map((e) => e.code);
  assert.ok(codes.includes('FACULTY_OVERLOAD'));
  assert.ok(codes.includes('UNKNOWN_COURSE'));
  assert.ok(codes.includes('UNKNOWN_SECTION'));
  const result = generate(problem, fast);
  assert.equal(result.status, 'invalid');
});

test('validateProblem reports when no room is big enough', () => {
  const problem = sample();
  problem.sections[0].size = 500;
  assert.ok(validateProblem(problem).some((e) => e.code === 'NO_ROOM'));
});

test('over-constrained input returns a partial, still clash-free timetable', () => {
  const problem = sample();
  problem.rooms = problem.rooms.filter((r) => r.type === 'lecture').concat([{ id: 'lab-1', name: 'Only Lab', type: 'lab', capacity: 70 }]);
  const result = generate(problem, { ...fast, timeLimitMs: 1500, maxIters: 2000 });
  assert.equal(result.status, 'partial');
  assert.ok(result.unplaced.length > 0);
  const placed = result.events.filter((e) => e.day !== null);
  assert.deepEqual(checkTimetable(problem, placed), []);
});

test('checkTimetable flags a manual double booking', () => {
  const problem = sample();
  const { events } = generate(problem, fast);
  const a = events.find((e) => e.sectionIds[0] === 'sec-a' && e.duration === 1 && e.kind === 'offering');
  const b = events.find((e) => e !== a && e.sectionIds[0] === 'sec-a' && e.duration === 1 && e.kind === 'offering' && (e.day !== a.day || e.start !== a.start));
  const edited = events.map((e) => (e === b ? { ...b, day: a.day, start: a.start } : e));
  const clashes = checkTimetable(problem, edited);
  assert.ok(clashes.some((c) => c.type === 'section' && c.eventIds.includes(a.id) && c.eventIds.includes(b.id)));
  assert.equal(scoreTimetable(problem, edited), null);
  assert.equal(typeof scoreTimetable(problem, events).soft, 'number');
});

test('suggestSubstitutes lists free colleagues, qualified first', () => {
  const problem = sample();
  const { events } = generate(problem, fast);
  const teacher = problem.faculty.find((f) => f.canTeach.includes('ps'));
  const day = events.find((e) => e.parts.some((p) => p.facultyId === teacher.id)).day;
  const subs = suggestSubstitutes(problem, events, teacher.id, day);
  assert.ok(subs.length > 0);
  for (const s of subs) {
    for (const cand of s.candidates) {
      const clash = events.some((e) => e.day === day && e.parts.some((p) => p.facultyId === cand.facultyId) && e.start < s.start + s.duration && s.start < e.start + e.duration);
      assert.ok(!clash, `${cand.name} is not actually free`);
    }
    const firstUnqualified = s.candidates.findIndex((c) => !c.qualified);
    if (firstUnqualified >= 0) assert.ok(s.candidates.slice(firstUnqualified).every((c) => !c.qualified));
  }
});

test('scales to a large school (40 sections) without clashes', () => {
  const problem = buildProblem({ sectionCount: 40 });
  const result = generate(problem, { seed: 3, maxIters: 20000, timeLimitMs: 60000 });
  assert.equal(result.status, 'ok');
  assert.deepEqual(checkTimetable(problem, result.events), []);
});

test('validation rejects a basket that needs more rooms at once than exist', () => {
  const p = buildProblem({ sectionCount: 4 });
  p.rooms = p.rooms.filter((r) => r.type === 'lab').concat(p.rooms.filter((r) => r.type === 'lecture').slice(0, 3));
  const errors = validateProblem(p);
  assert.ok(errors.some((e) => e.code === 'BASKET_ROOMS'), JSON.stringify(errors));
});

test('validation counts a section\'s blocked periods', () => {
  const p = buildProblem({ sectionCount: 4 });
  const a = p.sections.find((s) => s.id === 'sec-a');
  for (let day = 0; day < 5; day++) for (let period = 1; period < 8; period += 2) a.unavailable.push({ day, period });
  assert.ok(validateProblem(p).some((e) => e.code === 'SECTION_OVERLOAD' && e.ref === 'sec-a'));
});

test('one impossible class does not stop the rest from being scheduled', () => {
  const p = buildProblem({ sectionCount: 4 });
  // A small extra section whose only lab can never fit: it is free just one period at a
  // time, but labs need two in a row. Everything else must still be scheduled.
  p.sections.push({ id: 'sec-z', name: 'Z', size: 30, unavailable: [] });
  for (let day = 0; day < 5; day++) for (let period = 1; period < 8; period += 2) p.sections.at(-1).unavailable.push({ day, period });
  p.faculty.push({ id: 'fac-z', name: 'Dr. Z', maxPerDay: 4, maxPerWeek: 18, unavailable: [], avoid: [], canTeach: [] });
  p.offerings.push({ id: 'off-z', courseId: 'cn-lab', facultyId: 'fac-z', sectionIds: ['sec-z'] });
  assert.deepEqual(validateProblem(p), []);
  const r = generate(p, { seed: 5, timeLimitMs: 1500 });
  assert.equal(r.status, 'partial');
  assert.deepEqual(r.unplaced.map((u) => u.eventId), ['off-z#1'], 'only the impossible lab is unplaced');
  assert.deepEqual(checkTimetable(p, r.events).filter((c) => c.type !== 'unplaced'), []);
});

test('an offering can set its own class length and classes per week', () => {
  const p = buildProblem({ sectionCount: 4 });
  const o = p.offerings.find((x) => x.courseId === 'cn'); // a 1-period lecture, 3 a week by default
  o.duration = 3;
  o.sessionsPerWeek = 2;
  const r = generate(p, { seed: 9, timeLimitMs: 1500 });
  const mine = r.events.filter((e) => e.key === o.id);
  assert.equal(mine.length, 2);
  assert.ok(mine.every((e) => e.duration === 3 && e.day !== null));
  assert.deepEqual(checkTimetable(p, r.events), []);
  // Three periods can never cross the lunch break, so they must sit inside one half-day.
  assert.ok(mine.every((e) => !(e.start <= 4 && e.start + 3 > 4)));
});

test('validation rejects a class longer than the day allows between breaks', () => {
  const p = buildProblem({ sectionCount: 4 });
  p.offerings[0].duration = 5; // morning and afternoon are only 4 and 3 periods long
  assert.ok(validateProblem(p).some((e) => e.code === 'TOO_LONG'));
});
