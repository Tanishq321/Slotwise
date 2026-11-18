// Independent clash checker. It does not trust the solver: it re-reads a finished
// timetable and lists every hard-rule violation. The API uses it to validate manual
// drag-and-drop edits, and the tests use it to prove generated timetables are clean.

import { DEFAULT_CONFIG } from './problem.js';

export function checkTimetable(problem, events) {
  const cfg = { ...DEFAULT_CONFIG, ...(problem.config || {}) };
  const D = cfg.days.length;
  const P = cfg.periodsPerDay;
  const breaks = new Set(cfg.breaks);
  const rooms = new Map(problem.rooms.map((r) => [r.id, r]));
  const faculty = new Map(problem.faculty.map((f) => [f.id, f]));
  const sections = new Map(problem.sections.map((s) => [s.id, s]));
  const courses = new Map(problem.courses.map((c) => [c.id, c]));
  const clashes = [];
  const add = (type, message, eventIds, day, period) => clashes.push({ type, message, eventIds, day, period });
  const dayName = (d) => cfg.days[d] ?? `day ${d}`;
  const name = (map, id) => map.get(id)?.name || id;

  const grids = { section: new Map(), faculty: new Map(), room: new Map() };
  const occupy = (kind, id, d, p, eventId) => {
    const k = `${id}|${d}|${p}`;
    const list = grids[kind].get(k) || [];
    list.push(eventId);
    grids[kind].set(k, list);
  };
  const facDay = new Map();
  const keyDay = new Map();
  const keyTotal = new Map();
  for (const ev of events) keyTotal.set(ev.key, (keyTotal.get(ev.key) || 0) + 1);

  for (const ev of events) {
    if (ev.day == null || ev.start == null) {
      add('unplaced', `${ev.id} has no time slot`, [ev.id]);
      continue;
    }
    const { day: d, start: t, duration } = ev;
    if (d < 0 || d >= D || t < 0 || t + duration > P) {
      add('outOfDay', `${ev.id} runs outside the teaching day`, [ev.id], d, t);
      continue;
    }
    const kd = `${ev.key}|${d}`;
    keyDay.set(kd, [...(keyDay.get(kd) || []), ev.id]);
    for (let p = t; p < t + duration; p++) {
      if (breaks.has(p)) add('break', `${ev.id} is scheduled during a break (${dayName(d)}, period ${p + 1})`, [ev.id], d, p);
      for (const s of ev.sectionIds) {
        occupy('section', s, d, p, ev.id);
        const sec = sections.get(s);
        if (sec?.unavailable?.some((u) => u.day === d && u.period === p))
          add('sectionUnavailable', `${name(sections, s)} is not available on ${dayName(d)}, period ${p + 1}`, [ev.id], d, p);
      }
      for (const part of ev.parts) {
        occupy('faculty', part.facultyId, d, p, ev.id);
        if (part.roomId) occupy('room', part.roomId, d, p, ev.id);
        const f = faculty.get(part.facultyId);
        if (f?.unavailable?.some((u) => u.day === d && u.period === p))
          add('facultyUnavailable', `${f.name} is not available on ${dayName(d)}, period ${p + 1}`, [ev.id], d, p);
      }
    }
    for (const part of ev.parts) {
      const fd = `${part.facultyId}|${d}`;
      facDay.set(fd, (facDay.get(fd) || 0) + duration);
      const room = rooms.get(part.roomId);
      const course = courses.get(part.courseId);
      if (!room) {
        add('noRoom', `${ev.id} has no room`, [ev.id], d, t);
        continue;
      }
      const type = course?.type === 'lab' ? 'lab' : 'lecture';
      if (room.type !== type) add('roomType', `${course?.code || part.courseId} needs a ${type} room but ${room.name} is a ${room.type}`, [ev.id], d, t);
      if (part.size && room.capacity < part.size) add('capacity', `${room.name} holds ${room.capacity}, but ${part.size} students attend ${course?.code || ''}`.trim(), [ev.id], d, t);
    }
  }

  const labels = { section: (id) => name(sections, id), faculty: (id) => name(faculty, id), room: (id) => name(rooms, id) };
  for (const kind of ['section', 'faculty', 'room']) {
    for (const [k, ids] of grids[kind]) {
      const unique = [...new Set(ids)];
      if (unique.length > 1) {
        const [id, d, p] = k.split('|');
        add(kind, `${labels[kind](id)} is double-booked on ${dayName(+d)}, period ${+p + 1}`, unique, +d, +p);
      }
    }
  }
  for (const [k, hours] of facDay) {
    const [fid, d] = k.split('|');
    const f = faculty.get(fid);
    if (f?.maxPerDay && hours > f.maxPerDay) add('facultyDayLimit', `${f.name} teaches ${hours} periods on ${dayName(+d)} (limit ${f.maxPerDay})`, [], +d);
  }
  for (const [k, ids] of keyDay) {
    const key = k.slice(0, k.lastIndexOf('|'));
    const limit = Math.max(1, Math.ceil((keyTotal.get(key) || 1) / D));
    if (ids.length > limit) add('sameDay', `${key} meets ${ids.length} times on ${dayName(+k.split('|').pop())}`, ids, +k.split('|').pop());
  }
  return clashes;
}
