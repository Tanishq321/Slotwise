// Whole-dataset import/export, using the real Chitkara CSE and CSE-AI data (48 classes from two PDFs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import { checkTimetable } from '@slotwise/engine';
import { startTestApp, stopTestApp, sleep } from './helpers.js';

let app;
let admin;
let hod;
let dataset;
const CLASSES = 48;
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const upload = (token, obj, name = 'dataset.json') =>
  request(app).post('/api/dataset').set(auth(token)).attach('file', Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)), name);

before(async () => {
  app = await startTestApp();
  dataset = JSON.parse(await readFile(new URL('../data/chitkara-cse-ai.json', import.meta.url), 'utf8'));
  admin = (await request(app).post('/api/auth/register').send({ name: 'Admin', email: 'admin@example.com', password: 'longpassword1' })).body.token;
  hod = (await request(app).post('/api/auth/register').send({ name: 'Hod', email: 'hod@example.com', password: 'longpassword1' })).body.token;
  const { query } = await import('../src/db/pg.js');
  await query(`UPDATE users SET role = 'hod' WHERE email = 'hod@example.com'`);
  hod = (await request(app).post('/api/auth/login').send({ email: 'hod@example.com', password: 'longpassword1' })).body.token;
});
after(stopTestApp);

test('bad dataset files are rejected and nothing is written', async () => {
  assert.equal((await upload(hod, dataset)).status, 403, 'only admins can replace all data');
  assert.equal((await upload(admin, '{nope')).status, 400);
  assert.equal((await upload(admin, dataset, 'data.csv')).status, 400);

  const wrongFormat = await upload(admin, { ...dataset, format: 'something-else' });
  assert.equal(wrongFormat.status, 422);
  assert.match(JSON.stringify(wrongFormat.body), /not a Slotwise dataset/);

  const brokenRef = structuredClone(dataset);
  brokenRef.offerings[0].facultyId = 'fac-nobody';
  brokenRef.constraints[0].subjectId = 'no-such-class';
  const res = await upload(admin, brokenRef);
  assert.equal(res.status, 422);
  const msgs = JSON.stringify(res.body);
  assert.match(msgs, /fac-nobody/);
  assert.match(msgs, /no-such-class/);

  const sections = await request(app).get('/api/sections').set(auth(admin));
  assert.equal(sections.body.total, 0, 'a rejected file changes nothing');
});

test('the real dataset imports in one go and passes pre-flight', async () => {
  const res = await upload(admin, dataset, 'chitkara-cse-ai.json');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.imported, {
    rooms: dataset.rooms.length,
    faculty: dataset.faculty.length,
    sections: CLASSES,
    courses: dataset.courses.length,
    offerings: dataset.offerings.length,
    baskets: dataset.baskets.length,
    rules: dataset.constraints.length,
  });

  const pre = (await request(app).get('/api/timetables/preflight').set(auth(admin))).body;
  assert.equal(pre.ok, true, JSON.stringify(pre.errors));
  assert.equal(pre.summary.sections, CLASSES);
  assert.ok(pre.summary.periodsPerWeek > 500);

  const off = (await request(app).get('/api/offerings?limit=500').set(auth(admin))).body.items;
  const lac = off.find((o) => o.maxSessionsPerDay === 2);
  assert.ok(lac, 'per-offering limits come back from the API');
  assert.ok(off.some((o) => o.duration === 2 && o.courseType === 'lecture'), '2-hour lecture blocks are kept');
});

test('a complete, clash-free timetable is generated for all 48 classes', async () => {
  const res = await request(app).post('/api/timetables').set(auth(admin)).send({ name: 'Chitkara', timeLimitSec: 5, seed: 1 });
  assert.equal(res.status, 202);
  let tt;
  for (let i = 0; i < 120; i++) {
    tt = (await request(app).get(`/api/timetables/${res.body.id}`).set(auth(admin))).body;
    if (tt.status === 'done' || tt.status === 'failed') break;
    await sleep(250);
  }
  assert.equal(tt.status, 'done');
  assert.equal(tt.unplaced.length, 0);
  assert.deepEqual(checkTimetable(tt.problem, tt.events), []);
  assert.equal(new Set(tt.events.flatMap((e) => e.sectionIds)).size, CLASSES);
});

test('export gives back a file that re-imports to the same data', async () => {
  const exp = await request(app).get('/api/dataset').set(auth(hod));
  assert.equal(exp.status, 200);
  assert.match(exp.headers['content-disposition'], /slotwise-dataset\.json/);
  const out = JSON.parse(exp.text);
  for (const k of ['rooms', 'faculty', 'sections', 'courses', 'offerings', 'baskets', 'constraints']) assert.equal(out[k].length, dataset[k].length, k);
  const off = (id) => out.offerings.find((o) => o.id === id);
  for (const o of dataset.offerings) {
    assert.equal(off(o.id).duration, o.duration);
    assert.equal(off(o.id).sessionsPerWeek, o.sessionsPerWeek);
    assert.equal(off(o.id).maxSessionsPerDay, o.maxSessionsPerDay);
  }
  const again = await upload(admin, out);
  assert.equal(again.status, 200, JSON.stringify(again.body));
});

test('built-in datasets can be listed and loaded without uploading', async () => {
  const list = await request(app).get('/api/dataset/bundled').set(auth(hod));
  assert.equal(list.status, 200);
  assert.ok(list.body.items.some((x) => x.id === 'chitkara-cse-ai' && x.sections === CLASSES));
  assert.equal((await request(app).post('/api/dataset/bundled/chitkara-cse-ai').set(auth(hod))).status, 403);
  assert.equal((await request(app).post('/api/dataset/bundled/..%2Fpackage').set(auth(admin))).status, 400);
  const res = await request(app).post('/api/dataset/bundled/chitkara-cse-ai').set(auth(admin));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.imported.sections, CLASSES);
  const courses = (await request(app).get('/api/courses?limit=100').set(auth(admin))).body.items;
  assert.ok(courses.some((c) => c.department === 'CSE-AIML'), 'subjects are tagged with their stream');
  assert.ok(courses.some((c) => c.department === 'CSE'), 'the CSE groups from the second PDF are there too');
});

test('both PDFs make one dataset: CSE groups, shared teachers, and G15 shown first', async () => {
  const names = dataset.sections.map((s) => s.name);
  for (const n of ['CSE 5 G1', 'CSE 5 G11 (Cyber Security)', 'CSE 5 G13 (UCA)', 'CSE 5 G14 (iOS)', 'CSE 5 G15', 'CSE 5 G16 (Game Development)', 'CSE-AIML 5-iOS', 'CSE-AIML 5-UCA'])
    assert.ok(names.includes(n), n);
  assert.equal(names.filter((n) => /iOS/.test(n)).length, 2, 'the AIML iOS group is not listed twice');
  // A teacher named in both PDFs is one person, so the checker would see a double booking.
  const pummy = dataset.faculty.filter((f) => /pummy/i.test(f.name));
  assert.equal(pummy.length, 1);
  const taught = new Set(dataset.offerings.filter((o) => o.facultyId === pummy[0].id).flatMap((o) => o.sectionIds));
  assert.ok(taught.has('cse-5-g5') && taught.has('cse-aiml-g7'));
  assert.equal(dataset.sections.find((s) => s.id === 'cse-5-g1').homeRoomId, 'room-tg-303');

  const settings = (await request(app).get('/api/settings').set(auth(admin))).body.settings;
  assert.equal(settings.defaultSectionId, 'cse-5-g15');
  // Saving the form without the field keeps it; an unknown class is refused; null clears it.
  const { defaultSectionId, ...rest } = settings;
  assert.equal((await request(app).put('/api/settings').set(auth(admin)).send(rest)).body.settings.defaultSectionId, 'cse-5-g15');
  assert.equal((await request(app).put('/api/settings').set(auth(admin)).send({ ...rest, defaultSectionId: 'nope' })).status, 400);
  assert.equal((await request(app).put('/api/settings').set(auth(admin)).send({ ...rest, defaultSectionId: null })).body.settings.defaultSectionId, null);
  assert.equal((await request(app).put('/api/settings').set(auth(admin)).send({ ...rest, defaultSectionId })).body.settings.defaultSectionId, 'cse-5-g15');
});

test('deploy-time load clears old timetables and publishes the official timetable once', async () => {
  const { loadDatasetOnDeploy } = await import('../src/services/datasetLoader.js');
  const { Timetable } = await import('../src/models/Timetable.js');
  const before = await Timetable.countDocuments();
  assert.ok(before > 0, 'earlier tests left versions behind');
  const first = await loadDatasetOnDeploy('chitkara-cse-ai');
  assert.equal(first.imported.sections, CLASSES);
  assert.equal(first.official.published, true);
  assert.equal(first.official.clashes, 0, 'the official university timetable passes the clash checker');
  assert.equal(await Timetable.countDocuments(), 1, 'old versions are gone, only the official one is left');
  assert.equal(await loadDatasetOnDeploy('chitkara-cse-ai'), null, 'a restart with the same file does nothing');
  assert.equal(await Timetable.countDocuments(), 1);

  const pub = (await request(app).get('/api/timetables/published').set(auth(admin))).body;
  assert.equal(pub.events.length, dataset.official.events.length);
  assert.equal(pub.problem.defaultSectionId, 'cse-5-g15', 'the screen opens on CSE 5 G15');
  const g1Mon = pub.events.filter((e) => e.sectionIds.includes('cse-aiml-g1') && e.day === 0).sort((a, b) => a.start - b.start);
  const ref = dataset.official.events.filter((e) => e.sectionIds.includes('cse-aiml-g1') && e.day === 0).sort((a, b) => a.start - b.start);
  assert.deepEqual(g1Mon.map((e) => [e.start, e.parts[0].roomId]), ref.map((e) => [e.start, e.parts[0].roomId]), 'slots and rooms are exactly as in the PDF');
});

test('a student sees only their own class', async () => {
  const classes = (await request(app).get('/api/auth/classes')).body.items;
  assert.equal(classes.length, CLASSES, 'class names are public for the sign-up form');

  const reg = await request(app).post('/api/auth/register').send({ name: 'Riya', email: 'riya@example.com', password: 'longpassword1' });
  let riya = reg.body.token;
  const blocked = await request(app).get('/api/timetables/published').set(auth(riya));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.details.code, 'NO_SECTION');

  const pick = await request(app).patch('/api/auth/me/section').set(auth(riya)).send({ sectionId: 'cse-aiml-3g2' });
  assert.equal(pick.status, 200);
  riya = pick.body.token;
  const again = await request(app).patch('/api/auth/me/section').set(auth(riya)).send({ sectionId: 'cse-aiml-g1' });
  assert.equal(again.status, 403, 'only an admin can change it later');

  const tt = (await request(app).get('/api/timetables/published').set(auth(riya))).body;
  assert.deepEqual(tt.problem.sections.map((s) => s.id), ['cse-aiml-3g2']);
  assert.ok(tt.events.length > 0);
  assert.ok(tt.events.every((e) => e.sectionIds.length === 1 && e.sectionIds[0] === 'cse-aiml-3g2'));
  const teachersSeen = new Set(tt.events.flatMap((e) => e.parts.map((p) => p.facultyId)));
  assert.deepEqual(new Set(tt.problem.faculty.map((f) => f.id)), teachersSeen, 'no other teachers are listed');
  assert.ok(tt.problem.faculty.every((f) => !('unavailable' in f)), "teachers' private rules are not sent");

  const ics = await request(app).get(`/api/timetables/${tt.id}/ics?type=section&id=cse-aiml-g1`).set(auth(riya));
  assert.equal(ics.status, 200);
  assert.match(ics.headers['content-disposition'], /CSE-AIML_3G2/, 'the calendar is always their own class');

  const signup = await request(app).post('/api/auth/register').send({ name: 'Aman', email: 'aman@example.com', password: 'longpassword1', sectionId: 'cse-aift-5b' });
  const aman = (await request(app).get('/api/timetables/published').set(auth(signup.body.token))).body;
  assert.deepEqual(aman.problem.sections.map((s) => s.id), ['cse-aift-5b'], 'a class chosen at sign-up works straight away');
  assert.ok(aman.events.some((e) => e.kind === 'basket'), 'their elective groups are included');

  const full = (await request(app).get('/api/timetables/published').set(auth(admin))).body;
  assert.equal(full.problem.sections.length, CLASSES, 'admins still see everything');

  for (const path of ['/api/faculty', '/api/offerings', '/api/constraints', '/api/sections', '/api/rooms', '/api/courses', '/api/baskets', '/api/lookups', '/api/stats']) {
    assert.equal((await request(app).get(path).set(auth(riya))).status, 403, `students cannot read ${path}`);
  }
});

test('teachers see every class but not colleagues\' private rules', async () => {
  const { query } = await import('../src/db/pg.js');
  await request(app).post('/api/auth/register').send({ name: 'Teach', email: 'teach@example.com', password: 'longpassword1' });
  await query(`UPDATE users SET role = 'faculty', faculty_id = 'fac-dr-taniya' WHERE email = 'teach@example.com'`);
  const token = (await request(app).post('/api/auth/login').send({ email: 'teach@example.com', password: 'longpassword1' })).body.token;
  const tt = (await request(app).get('/api/timetables/published').set(auth(token))).body;
  assert.equal(tt.problem.sections.length, CLASSES);
  assert.ok(tt.problem.faculty.every((f) => !('unavailable' in f) && !('avoid' in f)));
  assert.equal((await request(app).get('/api/faculty').set(auth(token))).status, 403);
});

test('generated timetables keep each class in its home room most of the time', async () => {
  const res = await request(app).post('/api/timetables').set(auth(admin)).send({ name: 'Home rooms', timeLimitSec: 4, seed: 3 });
  let tt;
  for (let i = 0; i < 120; i++) {
    tt = (await request(app).get(`/api/timetables/${res.body.id}`).set(auth(admin))).body;
    if (tt.status === 'done' || tt.status === 'failed') break;
    await sleep(250);
  }
  assert.equal(tt.unplaced.length, 0);
  const sec = tt.problem.sections.find((s) => s.id === 'cse-aift-1a');
  assert.equal(sec.homeRoomId, 'room-nb-106a');
  const own = tt.events.filter((e) => e.kind === 'offering' && e.sectionIds.length === 1 && e.sectionIds[0] === sec.id);
  const home = own.filter((e) => e.parts[0].roomId === sec.homeRoomId).length;
  assert.ok(home / own.length > 0.7, `${home} of ${own.length} classes in the home room`);
});
