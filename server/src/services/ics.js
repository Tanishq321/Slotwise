// Builds an .ics calendar file (works with Google Calendar, Outlook, Apple Calendar).
// No API key needed: it's just a text format with one weekly-repeating event per class.

const pad = (n) => String(n).padStart(2, '0');
const escape = (s = '') => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

function nextMonday(from = new Date()) {
  const d = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate()));
  const add = (8 - d.getUTCDay()) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + (d.getUTCDay() === 1 ? 0 : add));
  return d;
}

const localStamp = (date, hhmm) => {
  const [h, m] = hhmm.split(':');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(h)}${pad(m)}00`;
};

export function buildIcs({ title, problem, events, termStart, termWeeks = 16, timezone = 'Asia/Kolkata' }) {
  const cfg = problem.config;
  const times = cfg.periodTimes || [];
  const courses = new Map(problem.courses.map((c) => [c.id, c]));
  const faculty = new Map(problem.faculty.map((f) => [f.id, f]));
  const rooms = new Map(problem.rooms.map((r) => [r.id, r]));
  const sections = new Map(problem.sections.map((s) => [s.id, s]));
  const monday = termStart ? new Date(`${termStart}T00:00:00Z`) : nextMonday();
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Slotwise//Timetable//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${escape(title)}`, `X-WR-TIMEZONE:${timezone}`];
  for (const ev of events) {
    if (ev.day == null || !times[ev.start] || !times[ev.start + ev.duration - 1]) continue;
    const date = new Date(monday);
    date.setUTCDate(monday.getUTCDate() + ev.day);
    for (const part of ev.parts) {
      const course = courses.get(part.courseId);
      lines.push(
        'BEGIN:VEVENT',
        `UID:${escape(`${ev.id}-${part.offeringId}`)}@slotwise`,
        `DTSTAMP:${now}`,
        `DTSTART;TZID=${timezone}:${localStamp(date, times[ev.start].start)}`,
        `DTEND;TZID=${timezone}:${localStamp(date, times[ev.start + ev.duration - 1].end)}`,
        `RRULE:FREQ=WEEKLY;COUNT=${termWeeks}`,
        `SUMMARY:${escape(`${course?.code || ''} ${course?.name || part.courseId}`.trim())}`,
        `LOCATION:${escape(rooms.get(part.roomId)?.name || '')}`,
        `DESCRIPTION:${escape(`Teacher: ${faculty.get(part.facultyId)?.name || ''}\nSections: ${ev.sectionIds.map((s) => sections.get(s)?.name || s).join(', ')}`)}`,
        'END:VEVENT',
      );
    }
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
