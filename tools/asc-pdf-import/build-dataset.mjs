#!/usr/bin/env node
// Turns parsed.json (from parse.mjs) into a Slotwise dataset file.
//
//   node build-dataset.mjs parsed.json chitkara-cse-ai.json
//
// The dataset describes WHAT has to be taught (who teaches which subject to which
// classes, how long each class is and how often) plus the official timetable itself.
//   * Same subject + teacher + room at the same time in several classes -> one combined class.
//   * Cells split into Group 1 / Group 2 -> an elective basket (options run in parallel).
//   * Each class keeps its own lunch hour as an "unavailable" rule (most classes break at
//     1-2 pm, CSE-AIFT 3rd semester at 12-1 pm).
//   * Teacher limits are raised where the real timetable already asks more of someone.
import { readFile, writeFile } from 'node:fs/promises';

const SECTION_SIZE = 60;
const ROOM_CAPACITY = 70;
const BIG_ROOMS = { Exploretorium: 400 };
// The university also teaches lectures (BPC, DNN) in the iOS Lab, so it is used as an
// ordinary room and no subject is forced into a lab.
const LAB_COURSES = new Set();
const LAB_ROOMS = new Set();
// The PDF puts "T- Himanshu" in two rooms at the same hour every day (Java for 3G4 and
// PA for 5G1), so these are two different trainers with the same name.
const TEACHER_SPLIT = { 't-himanshu|Java': 'T- Himanshu (Java)', 't-himanshu|PA': 'T- Himanshu (PA)' };
const BUILDINGS = { MB: 'Martin Luther Block', TG: 'Turing Block', NB: 'Newton Block', 'Bloom Block': 'Bloom Block' };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const TIMES = [['09:00', '10:00'], ['10:00', '11:00'], ['11:00', '12:00'], ['12:00', '13:00'], ['13:00', '14:00'], ['14:00', '15:00'], ['15:00', '16:00']];

export const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const clean = (label) => label.replace(/\s+/g, ' ').trim();
/** 'T- Ashish' and 'T-Ashish' are the same person: ignore spacing and dots. */
export const teacherKey = (label) => label.replace(/[\s.]/g, '').toLowerCase();

// Plain code-point comparison (so the order never depends on the computer's language settings).
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpList = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = Array.isArray(a[i]) ? cmpList(a[i], b[i]) : cmp(a[i], b[i]);
    if (c) return c;
  }
  return a.length - b.length;
};
const sorted = (list, by = cmp) => [...list].sort(by);
/** The most frequent key in a Map of counts; ties go to the key seen first. */
const mostCommon = (counts) => {
  let best = null;
  for (const [k, n] of counts) if (best === null || n > counts.get(best)) best = k;
  return best;
};
const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const getOr = (map, key, make) => {
  if (!map.has(key)) map.set(key, make());
  return map.get(key);
};

function sectionInfo(name) {
  const i = name.indexOf(' ');
  const program = name.slice(0, i);
  const m = name.slice(i + 1).match(/^(\d+)/);
  return { program, semester: m ? Number(m[1]) : 1 }; // 'G1' (no number) is 1st semester
}

export function buildDataset(classes) {
  for (const c of classes) for (const b of c.blocks) b.teacher = TEACHER_SPLIT[`${teacherKey(b.teacher)}|${clean(b.subject)}`] || b.teacher;

  const teacherName = new Map();
  const rooms = new Set();
  const sections = [];
  for (const c of classes) {
    sections.push({ id: slug(c.name), name: c.name, ...sectionInfo(c.name), size: SECTION_SIZE });
    for (const b of c.blocks) {
      if (!teacherName.has(teacherKey(b.teacher))) teacherName.set(teacherKey(b.teacher), clean(b.teacher));
      rooms.add(clean(b.room));
    }
  }
  const secId = new Map(classes.map((c) => [c.name, slug(c.name)]));

  // --- 1. Merge identical blocks across classes (combined classes) ---------------
  const plain = new Map(); // key -> { day, start, dur, subj, tk, room, secs:Set }
  const parallel = new Map(); // key -> { day, start, dur, opts:[[subj, tk, room]], secs:Set }
  for (const c of classes) {
    const slotOpts = new Map();
    for (const b of c.blocks) {
      const tk = teacherKey(b.teacher);
      if (b.parallel) {
        const slot = getOr(slotOpts, `${b.day}|${b.start}|${b.duration}`, () => ({ day: b.day, start: b.start, dur: b.duration, opts: new Map() }));
        const opt = [clean(b.subject), tk, clean(b.room)];
        slot.opts.set(JSON.stringify(opt), opt);
      } else {
        const row = { day: b.day, start: b.start, dur: b.duration, subj: clean(b.subject), tk, room: clean(b.room) };
        getOr(plain, JSON.stringify(Object.values(row)), () => ({ ...row, secs: new Set() })).secs.add(secId.get(c.name));
      }
    }
    for (const s of slotOpts.values()) {
      const opts = sorted([...s.opts.values()], cmpList);
      getOr(parallel, JSON.stringify([s.day, s.start, s.dur, opts]), () => ({ day: s.day, start: s.start, dur: s.dur, opts, secs: new Set() })).secs.add(secId.get(c.name));
    }
  }

  // --- 2. Offerings: who teaches what to whom, how long and how often ------------
  const offGroups = new Map();
  for (const p of plain.values()) {
    const secs = sorted(p.secs);
    const g = getOr(offGroups, JSON.stringify([p.subj, p.tk, secs, p.dur]), () => ({ subj: p.subj, tk: p.tk, secs, dur: p.dur, n: 0, days: new Map() }));
    g.n += 1;
    bump(g.days, p.day);
  }
  const offerings = [];
  const offId = new Map();
  sorted([...offGroups.entries()], ([, a], [, b]) => cmp(a.subj, b.subj) || cmpList(a.secs, b.secs) || cmp(a.tk, b.tk) || a.dur - b.dur).forEach(([key, g], i) => {
    const o = { id: `off-${String(i + 1).padStart(3, '0')}`, courseId: `crs-${slug(g.subj)}`, facultyId: `fac-${slug(teacherName.get(g.tk))}`, sectionIds: g.secs, duration: g.dur, sessionsPerWeek: g.n };
    const busiest = Math.max(...g.days.values());
    if (busiest > Math.ceil(g.n / 5)) o.maxSessionsPerDay = busiest; // e.g. two separate LAC periods on one day
    offerings.push(o);
    offId.set(key, o);
  });

  // --- 3. Elective baskets (parallel groups) -------------------------------------
  const bkGroups = new Map();
  for (const p of parallel.values()) {
    const secs = sorted(p.secs);
    const g = getOr(bkGroups, JSON.stringify([p.opts, secs, p.dur]), () => ({ opts: p.opts, secs, dur: p.dur, n: 0 }));
    g.n += 1;
  }
  const sectionName = new Map(sections.map((s) => [s.id, s.name]));
  const baskets = [];
  const bktId = new Map();
  sorted([...bkGroups.entries()], ([, a], [, b]) => cmpList(a.secs, b.secs)).forEach(([key, g], i) => {
    const nn = String(i + 1).padStart(2, '0');
    const names = sorted(g.secs.map((s) => sectionName.get(s)));
    const students = SECTION_SIZE * g.secs.length;
    const b = {
      id: `bkt-${nn}`,
      name: `${g.opts.map((o) => o[0]).join(' / ')} (${names.join(', ')})`,
      sectionIds: g.secs,
      sessionsPerWeek: g.n,
      duration: g.dur,
      options: g.opts.map(([s, tk], j) => ({ offeringId: `opt-${nn}-${j + 1}`, courseId: `crs-${slug(s)}`, facultyId: `fac-${slug(teacherName.get(tk))}`, size: Math.ceil(students / g.opts.length) })),
    };
    baskets.push(b);
    bktId.set(key, b);
  });

  // --- 4. Courses, tagged with the streams (CSE-AIML, CSE-AIFT) that study them ----
  const subjects = sorted([...new Set([...offerings.map((o) => o.courseId), ...baskets.flatMap((b) => b.options.map((o) => o.courseId))])]);
  const subjName = new Map();
  for (const c of classes) for (const b of c.blocks) subjName.set(`crs-${slug(clean(b.subject))}`, clean(b.subject));
  const usual = new Map();
  for (const o of offerings) bump(getOr(usual, o.courseId, () => new Map()), o.sessionsPerWeek);
  const secStream = new Map(sections.map((s) => [s.id, s.program]));
  const streamsOf = new Map();
  const tag = (key, sid) => getOr(streamsOf, key, () => new Set()).add(secStream.get(sid));
  for (const o of offerings) for (const sid of o.sectionIds) (tag(o.courseId, sid), tag(o.facultyId, sid));
  for (const b of baskets) for (const opt of b.options) for (const sid of b.sectionIds) (tag(opt.courseId, sid), tag(opt.facultyId, sid));
  const streamLabel = (key) => sorted([...(streamsOf.get(key) || [])]).join(', ') || 'CSE-AI';
  const courses = subjects.map((cid) => ({
    id: cid,
    code: subjName.get(cid),
    name: subjName.get(cid),
    type: LAB_COURSES.has(subjName.get(cid)) ? 'lab' : 'lecture',
    sessionsPerWeek: Math.max(1, Math.min(10, usual.has(cid) ? mostCommon(usual.get(cid)) : 2)),
    department: streamLabel(cid),
  }));

  // --- 5. Rooms: never smaller than the biggest class the PDF puts in them ----------
  const building = (name) => Object.entries(BUILDINGS).find(([prefix]) => name.startsWith(prefix))?.[1] ?? null;
  const realLoad = new Map();
  const load = (room, n) => realLoad.set(room, Math.max(realLoad.get(room) || 0, n));
  for (const p of plain.values()) load(p.room, SECTION_SIZE * p.secs.size);
  for (const p of parallel.values()) for (const [, , room] of p.opts) load(room, Math.ceil((SECTION_SIZE * p.secs.size) / p.opts.length));
  const roomList = sorted([...rooms]).map((r) => ({
    id: `room-${slug(r)}`,
    name: r,
    type: LAB_ROOMS.has(r) ? 'lab' : 'lecture',
    capacity: Math.max(BIG_ROOMS[r] ?? ROOM_CAPACITY, realLoad.get(r) || 0),
    building: building(r),
  }));

  // --- 6. Teacher limits (never below what the real timetable already needs) -------
  const week = new Map();
  const perDay = new Map();
  const teach = (tk, day, dur) => (bump(week, tk, dur), bump(perDay, `${tk}|${day}`, dur));
  for (const p of plain.values()) teach(p.tk, p.day, p.dur);
  for (const p of parallel.values()) for (const [, tk] of p.opts) teach(tk, p.day, p.dur);
  const canTeach = new Map();
  for (const o of offerings) getOr(canTeach, o.facultyId, () => new Set()).add(o.courseId);
  for (const b of baskets) for (const opt of b.options) getOr(canTeach, opt.facultyId, () => new Set()).add(opt.courseId);
  const faculty = sorted([...teacherName.entries()], ([, a], [, b]) => cmp(a.toLowerCase(), b.toLowerCase())).map(([tk, name]) => {
    const fid = `fac-${slug(name)}`;
    const maxDay = Math.max(0, ...DAYS.map((_, d) => perDay.get(`${tk}|${d}`) || 0));
    return { id: fid, name, maxPerDay: Math.min(12, Math.max(4, maxDay)), maxPerWeek: Math.min(60, Math.max(18, week.get(tk) || 0)), canTeach: sorted([...(canTeach.get(fid) || [])]), department: streamLabel(fid) };
  });
  if (new Set(faculty.map((f) => f.id)).size !== faculty.length) throw new Error('Two teachers ended up with the same id');

  // --- 7. Lunch: the middle period each class never uses ----------------------------
  const constraints = [];
  for (const c of classes) {
    const used = new Set(c.blocks.flatMap((b) => Array.from({ length: b.duration }, (_, k) => `${b.day}|${b.start + k}`)));
    for (const p of [4, 3]) {
      // 1-2 pm, else 12-1 pm
      if (DAYS.some((_, d) => used.has(`${d}|${p}`))) continue;
      for (let d = 0; d < DAYS.length; d++) constraints.push({ subjectType: 'section', subjectId: secId.get(c.name), kind: 'unavailable', day: d, periodFrom: p, periodTo: p, note: 'Lunch' });
      break;
    }
  }

  // --- 8. Home rooms and the official timetable, slot by slot ----------------------
  const roomId = new Map(roomList.map((r) => [r.name, r.id]));
  for (const sec of sections) {
    const use = new Map();
    for (const p of plain.values()) if (p.secs.size === 1 && p.secs.has(sec.id)) bump(use, p.room, p.dur);
    if (use.size) sec.homeRoomId = roomId.get(mostCommon(use)); // where the class spends most periods
  }
  const placed = [];
  for (const p of plain.values()) {
    const secs = sorted(p.secs);
    const o = offId.get(JSON.stringify([p.subj, p.tk, secs, p.dur]));
    placed.push({ key: o.id, day: p.day, start: p.start, ev: { kind: 'offering', duration: p.dur, sectionIds: secs, parts: [{ offeringId: o.id, courseId: o.courseId, facultyId: o.facultyId, roomId: roomId.get(p.room), size: SECTION_SIZE * secs.length }] } });
  }
  for (const p of parallel.values()) {
    const secs = sorted(p.secs);
    const b = bktId.get(JSON.stringify([p.opts, secs, p.dur]));
    placed.push({
      key: b.id,
      day: p.day,
      start: p.start,
      ev: { kind: 'basket', basketName: b.name, duration: p.dur, sectionIds: secs, parts: b.options.map((opt, j) => ({ offeringId: opt.offeringId, courseId: opt.courseId, facultyId: opt.facultyId, roomId: roomId.get(p.opts[j][2]), size: opt.size })) },
    });
  }
  const count = new Map();
  const officialEvents = sorted(placed, (a, b) => cmp(a.key, b.key) || a.day - b.day || a.start - b.start).map(({ key, day, start, ev }) => {
    bump(count, key);
    return { id: `${key}#${count.get(key)}`, key, ...ev, day, start };
  });

  return {
    format: 'slotwise-dataset/1',
    name: 'Chitkara University - CSE-AI department (odd semester 2026)',
    source: 'Class-wise timetable PDF generated 14-11-2026 (32 classes)',
    settings: { institution: 'Chitkara University - CSE-AI', days: DAYS, periodsPerDay: 7, breaks: [], labDuration: 2, periodTimes: TIMES.map(([start, end]) => ({ start, end })), termWeeks: 16 },
    rooms: roomList,
    faculty,
    sections,
    courses,
    offerings,
    baskets,
    constraints,
    official: { name: 'Official timetable (university PDF, 14-11-2026)', events: officialEvents },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [src = 'parsed.json', out = 'chitkara-cse-ai.json'] = process.argv.slice(2);
  const classes = JSON.parse(await readFile(src, 'utf8'));
  const d = buildDataset(classes);
  await writeFile(out, `${JSON.stringify(d, null, 1)}\n`);
  const periods = classes.reduce((n, c) => n + c.blocks.reduce((m, b) => m + b.duration, 0), 0);
  console.log(
    `${d.sections.length} sections, ${d.faculty.length} teachers, ${d.rooms.length} rooms, ${d.courses.length} courses, ` +
      `${d.offerings.length} offerings, ${d.baskets.length} baskets, ${d.constraints.length} lunch rules; ${periods} class-periods in the PDF`,
  );
}
