// Reads master data from PostgreSQL and turns it into the engine's problem format.
import { query } from '../db/pg.js';

export async function getSettings() {
  const { rows } = await query('SELECT * FROM settings WHERE id = 1');
  const s = rows[0];
  if (!s) return null;
  return {
    institution: s.institution,
    days: s.days,
    periodsPerDay: s.periods_per_day,
    breaks: s.breaks,
    labDuration: s.lab_duration,
    periodTimes: s.period_times,
    termStart: s.term_start,
    termWeeks: s.term_weeks,
    defaultSectionId: s.default_section_id ?? null,
  };
}

export async function buildProblemFromDb() {
  const settings = await getSettings();
  const [faculty, rooms, sections, courses, offerings, offSecs, baskets, basketSecs, options, canTeach, cons] = await Promise.all([
    query('SELECT * FROM faculty ORDER BY id'),
    query('SELECT * FROM rooms ORDER BY id'),
    query('SELECT * FROM sections ORDER BY id'),
    query('SELECT * FROM courses ORDER BY id'),
    query('SELECT * FROM offerings ORDER BY id'),
    query('SELECT * FROM offering_sections ORDER BY offering_id, section_id'),
    query('SELECT * FROM baskets ORDER BY id'),
    query('SELECT * FROM basket_sections ORDER BY basket_id, section_id'),
    query('SELECT * FROM basket_options ORDER BY basket_id, offering_id'),
    query('SELECT * FROM faculty_can_teach'),
    query('SELECT * FROM constraints ORDER BY id'),
  ]);

  const expand = (c) => {
    const out = [];
    for (let p = c.period_from; p <= c.period_to; p++) out.push({ day: c.day, period: p });
    return out;
  };
  const rulesFor = (type, id, kind) => cons.rows.filter((c) => c.subject_type === type && c.subject_id === id && c.kind === kind).flatMap(expand);
  const group = (rows, key, val) => rows.reduce((m, r) => m.set(r[key], [...(m.get(r[key]) || []), r[val]]), new Map());
  const secsByOffering = group(offSecs.rows, 'offering_id', 'section_id');
  const secsByBasket = group(basketSecs.rows, 'basket_id', 'section_id');
  const teachBy = group(canTeach.rows, 'faculty_id', 'course_id');

  return {
    config: settings
      ? { days: settings.days, periodsPerDay: settings.periodsPerDay, breaks: settings.breaks, labDuration: settings.labDuration, periodTimes: settings.periodTimes }
      : undefined,
    // Which class to show first on screen.
    ...(settings?.defaultSectionId ? { defaultSectionId: settings.defaultSectionId } : {}),
    rooms: rooms.rows.map((r) => ({ id: r.id, name: r.name, type: r.type, capacity: r.capacity, ...(r.building ? { building: r.building } : {}) })),
    faculty: faculty.rows.map((f) => ({
      id: f.id,
      name: f.name,
      ...(f.department ? { department: f.department } : {}),
      maxPerDay: f.max_per_day,
      maxPerWeek: f.max_per_week,
      unavailable: rulesFor('faculty', f.id, 'unavailable'),
      avoid: rulesFor('faculty', f.id, 'avoid'),
      canTeach: teachBy.get(f.id) || [],
    })),
    sections: sections.rows.map((s) => ({ id: s.id, name: s.name, size: s.size, ...(s.program ? { program: s.program } : {}), ...(s.semester ? { semester: s.semester } : {}), ...(s.home_room_id ? { homeRoomId: s.home_room_id } : {}), unavailable: rulesFor('section', s.id, 'unavailable') })),
    courses: courses.rows.map((c) => ({ id: c.id, code: c.code, name: c.name, type: c.type, sessionsPerWeek: c.sessions_per_week })),
    offerings: offerings.rows.map((o) => ({
      id: o.id,
      courseId: o.course_id,
      facultyId: o.faculty_id,
      sectionIds: secsByOffering.get(o.id) || [],
      ...(o.size ? { size: o.size } : {}),
      ...(o.duration ? { duration: o.duration } : {}),
      ...(o.sessions_per_week ? { sessionsPerWeek: o.sessions_per_week } : {}),
      ...(o.max_sessions_per_day ? { maxSessionsPerDay: o.max_sessions_per_day } : {}),
    })),
    baskets: baskets.rows.map((b) => ({
      id: b.id,
      name: b.name,
      sessionsPerWeek: b.sessions_per_week,
      duration: b.duration || 1,
      ...(b.max_sessions_per_day ? { maxSessionsPerDay: b.max_sessions_per_day } : {}),
      sectionIds: secsByBasket.get(b.id) || [],
      options: options.rows
        .filter((o) => o.basket_id === b.id)
        .map((o) => ({ offeringId: o.offering_id, courseId: o.course_id, facultyId: o.faculty_id, size: o.size })),
    })),
  };
}
