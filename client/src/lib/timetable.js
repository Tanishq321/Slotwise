// Helpers for showing a timetable: labels, per-course colours, and view filtering.

// Muted, distinguishable hues; each course always gets the same one.
const HUES = [
  ['#e7ecfb', '#3b56c4'], ['#e4f3ee', '#2f7d5b'], ['#fbe9df', '#b5562a'], ['#f1e7fa', '#7b49b0'],
  ['#e3f1f7', '#22769a'], ['#f8f0d9', '#9a7208'], ['#f9e5ee', '#ad3d6e'], ['#e8f0df', '#5a7d2a'],
  ['#ece9f7', '#5146a5'], ['#e0f0f0', '#2c7a7a'], ['#f4e8e1', '#8a5a3c'], ['#eceef2', '#4f5872'],
];
export function courseColor(courseId) {
  let h = 0;
  for (const ch of courseId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, bar] = HUES[h % HUES.length];
  return { bg, bar };
}

export function indexProblem(problem) {
  const map = (list) => new Map(list.map((x) => [x.id, x]));
  return { courses: map(problem.courses), faculty: map(problem.faculty), rooms: map(problem.rooms), sections: map(problem.sections) };
}

export const VIEW_TYPES = [
  { value: 'section', label: 'Section', list: 'sections' },
  { value: 'faculty', label: 'Teacher', list: 'faculty' },
  { value: 'room', label: 'Room', list: 'rooms' },
];

/** Events visible in one view. Teacher/room views keep only that person's/room's part. */
export function eventsForView(events, type, id) {
  if (!id) return [];
  if (type === 'section') return events.filter((e) => e.sectionIds.includes(id));
  const key = type === 'faculty' ? 'facultyId' : 'roomId';
  return events.filter((e) => e.parts.some((p) => p[key] === id)).map((e) => ({ ...e, parts: e.parts.filter((p) => p[key] === id) }));
}

export function periodLabel(cfg, p) {
  const t = cfg.periodTimes?.[p];
  return t ? `${t.start}–${t.end}` : `Period ${p + 1}`;
}

/** Time span of a class that starts at period `p` and lasts `duration` periods, e.g. "09:00–11:00". */
export function spanLabel(cfg, p, duration = 1) {
  const a = cfg.periodTimes?.[p];
  const b = cfg.periodTimes?.[p + duration - 1];
  if (a && b) return `${a.start}–${b.end}`;
  return duration > 1 ? `Periods ${p + 1}–${p + duration}` : `Period ${p + 1}`;
}

export const softLabels = {
  studentGaps: 'Free periods between classes',
  singleClassDays: 'Days with a single class',
  lateClasses: 'Classes in the last period',
  dayImbalance: 'Uneven days',
  facultyAvoidHits: 'Teacher preferences not met',
  facultyGaps: 'Idle periods for teachers',
};
