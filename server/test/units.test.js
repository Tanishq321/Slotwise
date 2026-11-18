// Fast unit tests for pure functions (no databases needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { parseWithRules, findDays, findPeriods } = await import('../src/services/constraintParser.js');
const { buildIcs } = await import('../src/services/ics.js');
const { viaApp } = await import('../src/services/analytics.js');
const { applyMove, filterEvents } = await import('../src/services/timetableEdit.js');
const { buildProblem } = await import('@samay/engine/data/build-problem.js');
const { generate, checkTimetable } = await import('@samay/engine');

const ctx = {
  days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  periodsPerDay: 8,
  breaks: [4],
  periodTimes: buildProblem().config.periodTimes,
  faculty: [
    { id: 'f1', name: 'Dr. Anjali Sharma' },
    { id: 'f2', name: 'Prof. Rohit Verma' },
    { id: 'f3', name: 'Dr. Neha Sharma' },
  ],
  sections: [{ id: 's1', name: 'CSE 5-A' }],
};

test('days: named days, plurals, weekdays, and "no day" = every day', () => {
  assert.deepEqual(findDays('on Mondays and Thursdays', ctx.days), [0, 3]);
  assert.deepEqual(findDays('every day', ctx.days), [0, 1, 2, 3, 4]);
  assert.deepEqual(findDays('no classes after lunch', ctx.days), [0, 1, 2, 3, 4]);
});

test('periods: clock times, morning/afternoon, numbered and first/last periods', () => {
  assert.deepEqual(findPeriods("can't teach before 10", ctx), [0, 1]);
  assert.deepEqual(findPeriods('busy after 2 pm', ctx), [6, 7]);
  assert.deepEqual(findPeriods('between 10:50 and 12:30', ctx), [2, 3]);
  assert.deepEqual(findPeriods('mornings', ctx), [0, 1, 2, 3]);
  assert.deepEqual(findPeriods('afternoon', ctx), [5, 6, 7]);
  assert.deepEqual(findPeriods('period 3', ctx), [2]);
  assert.deepEqual(findPeriods('the last period', ctx), [7]);
});

test('full sentences become rules; preferences become soft "avoid" rules', () => {
  const hard = parseWithRules("Dr. Sharma can't teach before 10 on Mondays", ctx);
  assert.equal(hard.constraints[0].kind, 'unavailable');
  assert.ok(hard.warnings.some((w) => w.includes('could mean')), 'two teachers called Sharma → warning');

  const soft = parseWithRules('Rohit Verma prefers not to teach the first period', ctx);
  assert.deepEqual(soft.constraints.map((c) => [c.subjectId, c.kind, c.periodFrom, c.periodTo]), Array(5).fill(['f2', 'avoid', 0, 0]));

  const section = parseWithRules('CSE 5-A is unavailable on Wednesday afternoon', ctx);
  assert.equal(section.constraints[0].subjectType, 'section');
  assert.deepEqual([section.constraints[0].periodFrom, section.constraints[0].periodTo], [5, 7]);

  assert.equal(parseWithRules('nobody is free on Tuesday', ctx).constraints.length, 0);
});

const problem = buildProblem({ sectionCount: 4 });
const result = generate(problem, { seed: 3, timeLimitMs: 1500 });

test('ics: one weekly event per class part, with times from settings', () => {
  const ics = buildIcs({ title: 'CSE 5-A', problem, events: filterEvents(result.events, 'section', 'sec-a'), termStart: '2026-07-27', termWeeks: 16 });
  const count = (ics.match(/BEGIN:VEVENT/g) || []).length;
  const expected = filterEvents(result.events, 'section', 'sec-a').reduce((n, e) => n + e.parts.length, 0);
  assert.equal(count, expected);
  assert.match(ics, /DTSTART;TZID=Asia\/Kolkata:202607(2[7-9]|3[01])T\d{6}/);
  assert.ok(ics.includes('\r\n'), 'lines end with CRLF as the spec requires');
});

test('analytics fallback matches a hand count', () => {
  const a = viaApp(result.events);
  const placed = result.events.filter((e) => e.day != null);
  assert.equal(a.byDay.reduce((n, d) => n + d.classes, 0), placed.length);
  assert.equal(a.byRoom.reduce((n, r) => n + r.periods, 0), placed.reduce((n, e) => n + e.duration * e.parts.length, 0));
});

test('applyMove keeps the timetable clean or reports the new clash', () => {
  const ev = result.events.find((e) => e.kind === 'offering' && e.duration === 1);
  const other = result.events.find((e) => e.sectionIds[0] === ev.sectionIds[0] && e.id !== ev.id && e.duration === 1);
  const bad = applyMove(problem, result.events, ev.id, { day: other.day, start: other.start });
  assert.ok(bad.newClashes.some((c) => c.type === 'section'));
  assert.equal(result.events.find((e) => e.id === ev.id).day, ev.day, 'original events are not mutated');
  assert.equal(applyMove(problem, result.events, 'nope', { day: 0, start: 0 }), null);
  assert.deepEqual(checkTimetable(problem, result.events), []);
});
