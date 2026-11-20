// Turns the human-friendly problem JSON into compact, index-based structures
// that the solver can work with quickly (typed arrays instead of object lookups).
//
// Problem shape (see data/sample-problem.json for a full example):
// {
//   config:   { days: ['Mon',..], periodsPerDay: 8, breaks: [4], labDuration: 2 },
//   rooms:    [{ id, name, type: 'lecture'|'lab', capacity }],
//   faculty:  [{ id, name, maxPerDay, maxPerWeek, unavailable: [{day, period}], avoid: [{day, period}], canTeach: [courseId] }],
//   sections: [{ id, name, size, unavailable?: [{day, period}] }],
//   courses:  [{ id, code, name, type: 'lecture'|'lab', sessionsPerWeek }],
//   offerings:[{ id, courseId, facultyId, sectionIds: [..], size?, duration?, sessionsPerWeek?, maxSessionsPerDay? }], // a course taught to one or more sections
//   baskets:  [{ id, name, sectionIds, sessionsPerWeek, duration?, options: [{ offeringId, courseId, facultyId, size }] }] // NEP electives run in parallel
// `duration` (periods per class) and `sessionsPerWeek` on an offering override the course defaults,
// e.g. Java is a 2-period class for one batch and a 3-period class for another.
// }
// `day` is a 0-based index into config.days, `period` a 0-based index into the day.

export const DEFAULT_CONFIG = {
  days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  periodsPerDay: 8,
  breaks: [4],
  labDuration: 2,
};

const byId = (list = []) => new Map(list.map((x) => [x.id, x]));

/** Periods per class: the offering's own value, else 1 for lectures / labDuration for labs. */
export const sessionLength = (offering, course, cfg) => offering?.duration || (course?.type === 'lab' ? cfg.labDuration : 1);
/** Classes per week: the offering's own value, else the course's. */
export const sessionCount = (offering, course) => offering?.sessionsPerWeek ?? course?.sessionsPerWeek ?? 0;

/** Longest run of consecutive non-break periods in a day. */
function longestRun(P, breaks) {
  let best = 0;
  let run = 0;
  for (let p = 0; p < P; p++) {
    run = breaks.has(p) ? 0 : run + 1;
    best = Math.max(best, run);
  }
  return best;
}

/** Check the problem for mistakes and impossible demands before solving. */
export function validateProblem(problem) {
  const errors = [];
  const err = (code, message, ref) => errors.push({ code, message, ...(ref ? { ref } : {}) });
  const cfg = { ...DEFAULT_CONFIG, ...(problem.config || {}) };
  const D = cfg.days.length;
  const P = cfg.periodsPerDay;
  const breaks = new Set(cfg.breaks);
  const teachable = P - breaks.size;
  const maxRun = longestRun(P, breaks);

  if (!D) err('CONFIG', 'At least one teaching day is required');
  if (!P) err('CONFIG', 'periodsPerDay must be at least 1');

  const rooms = byId(problem.rooms);
  const faculty = byId(problem.faculty);
  const sections = byId(problem.sections);
  const courses = byId(problem.courses);

  for (const [name, list] of [['rooms', problem.rooms], ['faculty', problem.faculty], ['sections', problem.sections], ['courses', problem.courses]]) {
    const seen = new Set();
    for (const x of list || []) {
      if (x.id == null) err('MISSING_ID', `An item in ${name} has no id`);
      else if (seen.has(x.id)) err('DUPLICATE_ID', `Duplicate id "${x.id}" in ${name}`, x.id);
      seen.add(x.id);
    }
  }

  const facDemand = new Map();
  const secDemand = new Map();
  const addDemand = (map, id, n) => map.set(id, (map.get(id) || 0) + n);

  const checkPart = (ownerId, part, sectionIds) => {
    const course = courses.get(part.courseId);
    if (!course) return err('UNKNOWN_COURSE', `${ownerId}: unknown course "${part.courseId}"`, ownerId);
    if (!faculty.has(part.facultyId)) return err('UNKNOWN_FACULTY', `${ownerId}: unknown faculty "${part.facultyId}"`, ownerId);
    const size = part.size ?? sectionIds.reduce((s, id) => s + (sections.get(id)?.size || 0), 0);
    const type = course.type === 'lab' ? 'lab' : 'lecture';
    const fits = (problem.rooms || []).some((r) => r.type === type && r.capacity >= size);
    if (!fits) err('NO_ROOM', `${ownerId}: no ${type} room can hold ${size} students`, ownerId);
    return course;
  };

  for (const o of problem.offerings || []) {
    if (!o.sectionIds?.length) err('NO_SECTIONS', `Offering ${o.id} has no sections`, o.id);
    for (const s of o.sectionIds || []) if (!sections.has(s)) err('UNKNOWN_SECTION', `Offering ${o.id}: unknown section "${s}"`, o.id);
    const course = checkPart(o.id, o, o.sectionIds || []);
    if (!course) continue;
    const dur = sessionLength(o, course, cfg);
    const n = sessionCount(o, course);
    if (dur > maxRun) err('TOO_LONG', `${o.id}: a ${dur}-period class does not fit between breaks (longest run is ${maxRun})`, o.id);
    addDemand(facDemand, o.facultyId, n * dur);
    for (const s of o.sectionIds || []) addDemand(secDemand, s, n * dur);
  }

  for (const b of problem.baskets || []) {
    if (!b.options?.length) err('EMPTY_BASKET', `Elective basket ${b.name || b.id} has no options`, b.id);
    for (const s of b.sectionIds || []) if (!sections.has(s)) err('UNKNOWN_SECTION', `Basket ${b.id}: unknown section "${s}"`, b.id);
    const facs = new Set();
    for (const opt of b.options || []) {
      checkPart(`${b.id}/${opt.offeringId}`, opt, b.sectionIds || []);
      if (facs.has(opt.facultyId)) err('BASKET_FACULTY', `Basket ${b.id}: one teacher cannot teach two parallel options`, b.id);
      facs.add(opt.facultyId);
      addDemand(facDemand, opt.facultyId, (b.sessionsPerWeek || 0) * (b.duration || 1));
    }
    if ((b.duration || 1) > maxRun) err('TOO_LONG', `Basket ${b.name || b.id}: a ${b.duration}-period class does not fit between breaks`, b.id);
    for (const s of b.sectionIds || []) addDemand(secDemand, s, (b.sessionsPerWeek || 0) * (b.duration || 1));
    // All options run at the same time, so each needs its own room simultaneously.
    for (const type of ['lecture', 'lab']) {
      const opts = (b.options || []).filter((o) => (courses.get(o.courseId)?.type === 'lab' ? 'lab' : 'lecture') === type);
      if (!opts.length) continue;
      const smallest = Math.min(...opts.map((o) => o.size ?? 0));
      const usable = (problem.rooms || []).filter((r) => r.type === type && r.capacity >= smallest).length;
      if (usable < opts.length)
        err('BASKET_ROOMS', `Basket ${b.name || b.id} runs ${opts.length} ${type} options at once but only ${usable} suitable ${type} rooms exist`, b.id);
    }
  }

  for (const [fid, demand] of facDemand) {
    const f = faculty.get(fid);
    if (!f) continue;
    const unavailable = new Set((f.unavailable || []).map((u) => `${u.day}:${u.period}`)).size;
    const available = D * teachable - unavailable;
    if (f.maxPerWeek && demand > f.maxPerWeek)
      err('FACULTY_OVERLOAD', `${f.name} is assigned ${demand} hours but max is ${f.maxPerWeek}`, fid);
    if (f.maxPerDay && demand > f.maxPerDay * D)
      err('FACULTY_OVERLOAD', `${f.name} needs ${demand} hours but can teach at most ${f.maxPerDay * D} in a week`, fid);
    if (demand > available)
      err('FACULTY_UNAVAILABLE', `${f.name} needs ${demand} hours but is only available for ${available}`, fid);
  }
  for (const [sid, demand] of secDemand) {
    const s = sections.get(sid);
    if (!s) continue;
    const blocked = new Set((s.unavailable || []).filter((u) => !breaks.has(u.period)).map((u) => `${u.day}:${u.period}`)).size;
    const free = D * teachable - blocked;
    if (demand > free) err('SECTION_OVERLOAD', `${s.name} needs ${demand} hours but only ${free} periods in the week are free for it`, sid);
  }
  return errors;
}

/** Build the compact representation used by the solver. Assumes validateProblem passed. */
export function compileProblem(problem) {
  const cfg = { ...DEFAULT_CONFIG, ...(problem.config || {}) };
  const D = cfg.days.length;
  const P = cfg.periodsPerDay;
  const isBreak = new Uint8Array(P);
  for (const b of cfg.breaks) if (b >= 0 && b < P) isBreak[b] = 1;

  const rooms = problem.rooms.map((r, idx) => ({ ...r, idx }));
  const faculty = problem.faculty.map((f, idx) => ({ ...f, idx }));
  const sections = problem.sections.map((s, idx) => ({ ...s, idx }));
  const roomIdx = new Map(rooms.map((r) => [r.id, r.idx]));
  const facIdx = new Map(faculty.map((f) => [f.id, f.idx]));
  const secIdx = new Map(sections.map((s) => [s.id, s.idx]));
  const courses = byId(problem.courses);
  const R = rooms.length;
  const F = faculty.length;
  const S = sections.length;

  const facUnavail = new Uint8Array(F * D * P);
  const facAvoid = new Uint8Array(F * D * P);
  const secUnavail = new Uint8Array(S * D * P);
  const maxPerDay = new Int16Array(F);
  faculty.forEach((f) => {
    maxPerDay[f.idx] = f.maxPerDay || P;
    for (const u of f.unavailable || []) facUnavail[(f.idx * D + u.day) * P + u.period] = 1;
    for (const u of f.avoid || []) facAvoid[(f.idx * D + u.day) * P + u.period] = 1;
  });
  sections.forEach((s) => {
    for (const u of s.unavailable || []) secUnavail[(s.idx * D + u.day) * P + u.period] = 1;
  });

  // Rooms that could host a part, smallest first (best fit keeps big rooms free).
  const candidateRooms = (type, size) =>
    rooms.filter((r) => r.type === type && r.capacity >= size).sort((a, b) => a.capacity - b.capacity).map((r) => r.idx);

  const events = [];
  const keys = [];
  // By default a subject is spread out (at most ceil(classes / days) per day); an offering
  // can allow more, e.g. two separate LAC periods on the same day as in many real timetables.
  const addKey = (id, total, maxSessionsPerDay) => {
    keys.push({ id, total, limit: Math.max(1, Math.ceil(total / D), maxSessionsPerDay || 0), events: [] });
    return keys.length - 1;
  };

  for (const o of problem.offerings || []) {
    const course = courses.get(o.courseId);
    const type = course.type === 'lab' ? 'lab' : 'lecture';
    const duration = sessionLength(o, course, cfg);
    const size = o.size ?? o.sectionIds.reduce((s, id) => s + (sections[secIdx.get(id)].size || 0), 0);
    const n = sessionCount(o, course);
    const k = addKey(o.id, n, o.maxSessionsPerDay);
    for (let i = 0; i < n; i++) {
      events.push({
        id: `${o.id}#${i + 1}`,
        key: o.id,
        keyIdx: k,
        kind: 'offering',
        duration,
        groups: o.sectionIds.map((s) => secIdx.get(s)),
        parts: [{ offeringId: o.id, courseId: o.courseId, facIdx: facIdx.get(o.facultyId), size, type, candidates: candidateRooms(type, size) }],
      });
    }
  }
  for (const b of problem.baskets || []) {
    const n = b.sessionsPerWeek || 0;
    const k = addKey(b.id, n, b.maxSessionsPerDay);
    for (let i = 0; i < n; i++) {
      events.push({
        id: `${b.id}#${i + 1}`,
        key: b.id,
        keyIdx: k,
        kind: 'basket',
        basketName: b.name,
        duration: b.duration || 1,
        groups: b.sectionIds.map((s) => secIdx.get(s)),
        parts: b.options.map((opt) => {
          const course = courses.get(opt.courseId);
          const type = course.type === 'lab' ? 'lab' : 'lecture';
          const size = opt.size ?? 0;
          return { offeringId: opt.offeringId, courseId: opt.courseId, facIdx: facIdx.get(opt.facultyId), size, type, candidates: candidateRooms(type, size) };
        }),
      });
    }
  }

  events.forEach((e, idx) => {
    e.idx = idx;
    keys[e.keyIdx].events.push(idx);
    e.facs = [...new Set(e.parts.map((p) => p.facIdx))];
    // Static difficulty: longer, bigger, multi-section events are harder to place.
    e.difficulty = e.duration * 4 + e.parts.length * 2 + e.groups.length;
  });

  // Which events share a section or teacher — used to refresh only nearby events.
  const secEvents = Array.from({ length: S }, () => []);
  const facEvents = Array.from({ length: F }, () => []);
  for (const e of events) {
    for (const s of e.groups) secEvents[s].push(e.idx);
    for (const f of e.facs) facEvents[f].push(e.idx);
  }
  for (const e of events) {
    const n = new Set();
    for (const s of e.groups) for (const x of secEvents[s]) n.add(x);
    for (const f of e.facs) for (const x of facEvents[f]) n.add(x);
    n.delete(e.idx);
    e.neighbors = [...n];
  }

  return {
    cfg, D, P, isBreak, rooms, faculty, sections, courses, roomIdx, facIdx, secIdx,
    R, F, S, facUnavail, facAvoid, secUnavail, maxPerDay, events, keys, secEvents, facEvents,
  };
}
