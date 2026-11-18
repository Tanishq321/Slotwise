// End-to-end API tests: auth, roles, CRUD, CSV import, generation through the queue,
// live progress, manual edits, publishing, analytics, substitutes and calendar export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { checkTimetable } from '@samay/engine';
import { startTestApp, stopTestApp, sleep } from './helpers.js';

let app;
let admin; // token
let student;
let ttId;

before(async () => {
  app = await startTestApp();
});
after(stopTestApp);

const auth = (token) => ({ Authorization: `Bearer ${token}` });

test('first account becomes admin, later ones are students', async () => {
  const a = await request(app).post('/api/auth/register').send({ name: 'Asha Admin', email: 'Asha@Example.com', password: 'longpassword1' });
  assert.equal(a.status, 201);
  assert.equal(a.body.user.role, 'admin');
  assert.equal(a.body.user.email, 'asha@example.com', 'emails are normalised to lower case');
  admin = a.body.token;

  const s = await request(app).post('/api/auth/register').send({ name: 'Sam Student', email: 'sam@example.com', password: 'longpassword2' });
  assert.equal(s.body.user.role, 'student');
  student = s.body.token;

  const dup = await request(app).post('/api/auth/register').send({ name: 'Sam Again', email: 'SAM@example.com', password: 'longpassword3' });
  assert.equal(dup.status, 409);
  const bad = await request(app).post('/api/auth/register').send({ name: 'X', email: 'not-an-email', password: 'short' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.details.length >= 2, 'every invalid field is reported');
});

test('login checks the password and /me returns the user', async () => {
  const wrong = await request(app).post('/api/auth/login').send({ email: 'asha@example.com', password: 'nope-nope' });
  assert.equal(wrong.status, 401);
  const ok = await request(app).post('/api/auth/login').send({ email: 'asha@example.com', password: 'longpassword1' });
  assert.equal(ok.status, 200);
  const me = await request(app).get('/api/auth/me').set(auth(ok.body.token));
  assert.equal(me.body.user.name, 'Asha Admin');
  assert.equal((await request(app).get('/api/stats')).status, 401, 'protected routes need a token');
  assert.equal((await request(app).get('/api/stats').set(auth('garbage'))).status, 401);
});

test('role-based access: students cannot change master data', async () => {
  const res = await request(app).post('/api/rooms').set(auth(student)).send({ name: 'R1', type: 'lecture', capacity: 40 });
  assert.equal(res.status, 403);
  assert.equal((await request(app).get('/api/users').set(auth(student))).status, 403);
});

test('rooms CRUD with validation, search, sorting and pagination', async () => {
  const bad = await request(app).post('/api/rooms').set(auth(admin)).send({ name: '', type: 'hall', capacity: -3 });
  assert.equal(bad.status, 400);

  for (const [name, capacity] of [['Alpha 1', 40], ['Alpha 2', 80], ['Beta 1', 60]]) {
    const r = await request(app).post('/api/rooms').set(auth(admin)).send({ name, type: 'lecture', capacity, building: 'Main' });
    assert.equal(r.status, 201);
  }
  const page = await request(app).get('/api/rooms?q=alpha&sort=capacity&order=desc&limit=1&page=1').set(auth(admin));
  assert.equal(page.body.total, 2);
  assert.equal(page.body.pages, 2);
  assert.equal(page.body.items[0].name, 'Alpha 2');

  const id = page.body.items[0].id;
  const patched = await request(app).patch(`/api/rooms/${id}`).set(auth(admin)).send({ capacity: 90 });
  assert.equal(patched.body.capacity, 90);
  assert.equal(patched.body.building, 'Main', 'PATCH leaves other fields alone');
  assert.equal((await request(app).delete(`/api/rooms/${id}`).set(auth(admin))).status, 204);
  assert.equal((await request(app).get(`/api/rooms/${id}`).set(auth(admin))).status, 404);
});

test('CSV import is all-or-nothing and reports bad lines', async () => {
  const tpl = await request(app).get('/api/import/sections/template').set(auth(admin));
  assert.match(tpl.text, /^name,program,semester,size/);

  const before = (await request(app).get('/api/sections').set(auth(admin))).body.total;
  const broken = 'name,program,semester,size\nCSE 3-A,B.E. CSE,3,60\nCSE 3-B,B.E. CSE,3,not-a-number\n';
  const res = await request(app).post('/api/import/sections').set(auth(admin)).attach('file', Buffer.from(broken), 'sections.csv');
  assert.equal(res.status, 422);
  assert.equal(res.body.details.rows[0].line, 3);
  assert.equal((await request(app).get('/api/sections').set(auth(admin))).body.total, before, 'nothing saved');

  const good = 'Name,Program,Semester,Size\nCSE 3-A,B.E. CSE,3,60\nCSE 3-B,B.E. CSE,3,58\n';
  const ok = await request(app).post('/api/import/sections').set(auth(admin)).attach('file', Buffer.from(good), 'sections.csv');
  assert.equal(ok.body.imported, 2);
  const again = await request(app).post('/api/import/sections').set(auth(admin)).attach('file', Buffer.from(good), 'sections.csv');
  assert.equal(again.status, 200);
  assert.equal((await request(app).get('/api/sections').set(auth(admin))).body.total, before + 2, 're-importing updates instead of duplicating');

  const notCsv = await request(app).post('/api/import/sections').set(auth(admin)).attach('file', Buffer.from('x'), 'photo.png');
  assert.equal(notCsv.status, 400);
});

test('demo data passes the pre-flight check', async () => {
  const { seed } = await import('../src/db/seed.js');
  await seed({ reset: true });
  const login = await request(app).post('/api/auth/login').send({ email: 'admin@samay.dev', password: 'Samay@2026' });
  admin = login.body.token;
  student = (await request(app).post('/api/auth/login').send({ email: 'student@samay.dev', password: 'Samay@2026' })).body.token;
  const pre = await request(app).get('/api/timetables/preflight').set(auth(admin));
  assert.equal(pre.body.ok, true, JSON.stringify(pre.body.errors));
  assert.equal(pre.body.summary.sections, 8);
  assert.ok(pre.body.summary.rules > 0);
});

test('plain-English rules are previewed, then saved on confirm', async () => {
  const preview = await request(app).post('/api/constraints/parse').set(auth(admin)).send({ text: 'Dr. Anjali Sharma cannot teach after 2 pm on Fridays' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.source, 'rules', 'no Groq key in tests → built-in parser');
  const [rule] = preview.body.constraints;
  assert.equal(rule.subjectId, 'fac-001');
  assert.equal(rule.day, 4);
  assert.equal(rule.periodFrom, 6, '14:10 is the first period starting after 2 pm');
  const saved = await request(app).post('/api/constraints').set(auth(admin)).send({ constraints: preview.body.constraints, sourceText: 'test' });
  assert.equal(saved.status, 201);
  const list = await request(app).get('/api/constraints?subjectId=fac-001').set(auth(admin));
  assert.ok(list.body.items.some((c) => c.day === 4 && c.periodFrom === 6));
});

test('impossible input is rejected before queueing', async () => {
  // Give one teacher far more classes than their weekly limit allows.
  await request(app).patch('/api/faculty/fac-002').set(auth(admin)).send({ maxPerWeek: 1 });
  const res = await request(app).post('/api/timetables').set(auth(admin)).send({ timeLimitSec: 2 });
  assert.equal(res.status, 422);
  assert.ok(res.body.details.errors.some((e) => e.code === 'FACULTY_OVERLOAD'));
  await request(app).patch('/api/faculty/fac-002').set(auth(admin)).send({ maxPerWeek: 18 });
});

test('generation runs in the background and streams progress', async () => {
  const res = await request(app).post('/api/timetables').set(auth(admin)).send({ name: 'Test version', timeLimitSec: 3, seed: 7 });
  assert.equal(res.status, 202);
  ttId = res.body.id;

  const stream = await request(app).get(`/api/timetables/${ttId}/progress`).set(auth(admin)).buffer(true).parse((r, cb) => {
    let data = '';
    r.on('data', (c) => (data += c));
    r.on('end', () => cb(null, data));
  });
  assert.match(stream.headers['content-type'], /^text\/event-stream/);
  assert.match(stream.body, /event: progress/);
  assert.match(stream.body, /"status":"done"/);

  const tt = (await request(app).get(`/api/timetables/${ttId}`).set(auth(admin))).body;
  assert.equal(tt.status, 'done');
  assert.equal(tt.unplaced.length, 0);
  assert.deepEqual(checkTimetable(tt.problem, tt.events), [], 'independent checker finds zero clashes');
  const cached = await request(app).get(`/api/timetables/${ttId}`).set(auth(admin));
  assert.equal(cached.headers['x-cache'], 'HIT');
});

test('manual moves: clashes are refused, a free slot is accepted', async () => {
  const tt = (await request(app).get(`/api/timetables/${ttId}`).set(auth(admin))).body;
  const mine = tt.events.filter((e) => e.sectionIds.includes('sec-a') && e.kind === 'offering' && e.duration === 1);
  const [a] = mine;
  const b = mine.find((e) => e.day !== a.day);
  const url = `/api/timetables/${ttId}/events/${encodeURIComponent(a.id)}`;

  const clash = await request(app).patch(url).set(auth(admin)).send({ day: b.day, start: b.start });
  assert.equal(clash.status, 409);
  assert.ok(clash.body.details.clashes.some((c) => c.type === 'section'));

  let moved = null;
  outer: for (let day = 0; day < 5; day++) {
    for (let start = 0; start < 8; start++) {
      if (day === a.day && start === a.start) continue;
      const dry = await request(app).patch(url).set(auth(admin)).send({ day, start, dryRun: true });
      if (dry.body.ok) {
        moved = await request(app).patch(url).set(auth(admin)).send({ day, start });
        break outer;
      }
    }
  }
  assert.ok(moved, 'found at least one free slot');
  assert.equal(moved.status, 200);
  const after = (await request(app).get(`/api/timetables/${ttId}`).set(auth(admin))).body;
  assert.equal(after.editCount, 1);
  assert.deepEqual(checkTimetable(after.problem, after.events), []);
});

test('publishing makes the timetable visible to students', async () => {
  assert.equal((await request(app).get('/api/timetables/published').set(auth(student))).status, 404);
  assert.equal((await request(app).get(`/api/timetables/${ttId}`).set(auth(student))).status, 403);
  const pub = await request(app).post(`/api/timetables/${ttId}/publish`).set(auth(admin));
  assert.equal(pub.status, 200);
  const seen = await request(app).get('/api/timetables/published').set(auth(student));
  assert.equal(seen.status, 200);
  assert.equal(seen.body.id, ttId);
  assert.equal((await request(app).get('/api/timetables').set(auth(student))).status, 403, 'students cannot list drafts');
  assert.equal((await request(app).delete(`/api/timetables/${ttId}`).set(auth(admin))).status, 409, 'cannot delete the published version');
});

test('analytics, substitutes, compare and calendar export', async () => {
  const an = await request(app).get(`/api/timetables/${ttId}/analytics`).set(auth(admin));
  assert.equal(an.status, 200);
  const tt = (await request(app).get(`/api/timetables/${ttId}`).set(auth(admin))).body;
  const placed = tt.events.filter((e) => e.day != null);
  assert.equal(an.body.days.reduce((n, d) => n + d.classes, 0), placed.length);
  assert.equal(an.body.faculty.reduce((n, f) => n + f.periods, 0), placed.reduce((n, e) => n + e.duration * e.parts.length, 0));

  const day = placed.find((e) => e.parts.some((p) => p.facultyId === 'fac-002')).day;
  const subs = await request(app).get(`/api/timetables/${ttId}/substitutes?facultyId=fac-002&day=${day}`).set(auth(admin));
  assert.ok(subs.body.items.length > 0);
  assert.ok(subs.body.items.every((i) => i.candidates.every((c) => c.facultyId !== 'fac-002')));

  const second = await request(app).post('/api/timetables').set(auth(admin)).send({ timeLimitSec: 2, seed: 99 });
  for (let i = 0; i < 60; i++) {
    const s = (await request(app).get(`/api/timetables/${second.body.id}`).set(auth(admin))).body.status;
    if (s === 'done') break;
    await sleep(250);
  }
  const cmp = await request(app).get(`/api/timetables/compare?a=${ttId}&b=${second.body.id}`).set(auth(admin));
  assert.equal(cmp.status, 200);
  assert.equal(cmp.body.sameSlot + cmp.body.moved, tt.events.length);

  const ics = await request(app).get(`/api/timetables/${ttId}/ics?type=section&id=sec-a`).set(auth(student));
  assert.equal(ics.status, 200);
  assert.match(ics.headers['content-type'], /text\/calendar/);
  assert.match(ics.text, /BEGIN:VEVENT[\s\S]*RRULE:FREQ=WEEKLY;COUNT=16/);
});

test('audit log records who did what', async () => {
  const log = await request(app).get('/api/audit?limit=100').set(auth(admin));
  const actions = log.body.items.map((x) => x.action);
  for (const a of ['generate', 'move', 'publish', 'import']) assert.ok(actions.includes(a), `missing ${a}`);
});
