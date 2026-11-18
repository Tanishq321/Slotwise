// "Teacher absent today" helper: for each class the absent teacher has that day,
// list colleagues who are free at that time, under their daily limit, and ideally
// qualified to teach the course.

import { DEFAULT_CONFIG } from './problem.js';

export function suggestSubstitutes(problem, events, absentFacultyId, day, { limit = 5 } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(problem.config || {}) };
  const courses = new Map(problem.courses.map((c) => [c.id, c]));
  const busy = new Set();
  const load = new Map();
  for (const ev of events) {
    if (ev.day !== day) continue;
    for (const part of ev.parts) {
      for (let p = ev.start; p < ev.start + ev.duration; p++) busy.add(`${part.facultyId}|${p}`);
      load.set(part.facultyId, (load.get(part.facultyId) || 0) + ev.duration);
    }
  }

  const result = [];
  for (const ev of events) {
    if (ev.day !== day) continue;
    for (const part of ev.parts) {
      if (part.facultyId !== absentFacultyId) continue;
      const candidates = [];
      for (const f of problem.faculty) {
        if (f.id === absentFacultyId) continue;
        let free = true;
        for (let p = ev.start; p < ev.start + ev.duration && free; p++) {
          if (busy.has(`${f.id}|${p}`)) free = false;
          if ((f.unavailable || []).some((u) => u.day === day && u.period === p)) free = false;
        }
        if (!free) continue;
        const dayLoad = load.get(f.id) || 0;
        if (f.maxPerDay && dayLoad + ev.duration > f.maxPerDay) continue;
        const qualified = (f.canTeach || []).includes(part.courseId);
        candidates.push({ facultyId: f.id, name: f.name, qualified, periodsToday: dayLoad });
      }
      candidates.sort((a, b) => Number(b.qualified) - Number(a.qualified) || a.periodsToday - b.periodsToday || a.name.localeCompare(b.name));
      const course = courses.get(part.courseId);
      result.push({
        eventId: ev.id,
        courseId: part.courseId,
        courseCode: course?.code,
        courseName: course?.name,
        day,
        dayName: cfg.days[day],
        start: ev.start,
        duration: ev.duration,
        sectionIds: ev.sectionIds,
        roomId: part.roomId,
        candidates: candidates.slice(0, limit),
      });
    }
  }
  return result.sort((a, b) => a.start - b.start);
}
