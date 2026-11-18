// Loads a realistic demo: one 5th-semester CSE department (8 sections, 25 teachers,
// NEP open-elective baskets, a few personal constraints) plus four demo logins.
// `npm run seed` keeps existing data; `npm run seed -- --reset` wipes it first.
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { buildProblem } from '@slotwise/engine/data/build-problem.js';
import { pool, transaction } from './pg.js';
import { migrate } from './migrate.js';
import { logger } from '../utils/logger.js';

export const DEMO_PASSWORD = 'Slotwise@2026';
export const DEMO_USERS = [
  { name: 'Admin User', email: 'admin@slotwise.dev', role: 'admin' },
  { name: 'Head of Department', email: 'hod@slotwise.dev', role: 'hod' },
  { name: 'Dr. Anjali Sharma', email: 'faculty@slotwise.dev', role: 'faculty', facultyId: 'fac-001' },
  { name: 'Demo Student', email: 'student@slotwise.dev', role: 'student', sectionId: 'sec-a' },
];

const ranges = (slots) => {
  // [{day, period}] → [{day, from, to}] with consecutive periods merged.
  const out = [];
  const sorted = [...slots].sort((a, b) => a.day - b.day || a.period - b.period);
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && last.day === s.day && last.to === s.period - 1) last.to = s.period;
    else out.push({ day: s.day, from: s.period, to: s.period });
  }
  return out;
};

export async function seed({ reset = false, sectionCount = 8 } = {}) {
  await migrate();
  const p = buildProblem({ sectionCount });
  const courseIds = new Set(p.courses.map((c) => c.id));
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);

  await transaction(async (c) => {
    if (reset) {
      await c.query(`TRUNCATE users, constraints, faculty_can_teach, basket_options, basket_sections, baskets,
        offering_sections, offerings, courses, sections, rooms, faculty, settings RESTART IDENTITY CASCADE`);
    }
    await c.query(
      `INSERT INTO settings (id, institution, days, periods_per_day, breaks, lab_duration, period_times, term_weeks)
       VALUES (1, $1, $2, $3, $4, $5, $6, 16) ON CONFLICT (id) DO NOTHING`,
      ['Demo Institute of Technology — CSE', JSON.stringify(p.config.days), p.config.periodsPerDay, JSON.stringify(p.config.breaks), p.config.labDuration, JSON.stringify(p.config.periodTimes)],
    );
    for (const r of p.rooms) {
      await c.query('INSERT INTO rooms (id, name, type, capacity, building) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING', [
        r.id, r.name, r.type, r.capacity, r.type === 'lab' ? 'Block C' : 'Block A',
      ]);
    }
    for (const s of p.sections) {
      await c.query('INSERT INTO sections (id, name, program, semester, size) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING', [s.id, s.name, 'B.E. CSE', 5, s.size]);
    }
    for (const co of p.courses) {
      await c.query('INSERT INTO courses (id, code, name, type, sessions_per_week, department) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING', [
        co.id, co.code, co.name, co.type, co.sessionsPerWeek, co.id.startsWith('oe-') ? 'Open Elective' : 'CSE',
      ]);
    }
    for (const f of p.faculty) {
      const slug = f.name.replace(/^Dr\.\s*/, '').toLowerCase().replace(/[^a-z]+/g, '.');
      await c.query('INSERT INTO faculty (id, name, email, department, max_per_day, max_per_week) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING', [
        f.id, f.name, `${slug}.${f.id.slice(4)}@demo.edu`, f.canTeach.some((x) => x.startsWith('oe-')) ? 'Humanities' : 'CSE', f.maxPerDay, f.maxPerWeek,
      ]);
      for (const courseId of new Set(f.canTeach.filter((x) => courseIds.has(x)))) {
        await c.query('INSERT INTO faculty_can_teach (faculty_id, course_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [f.id, courseId]);
      }
      for (const [kind, slots] of [['unavailable', f.unavailable], ['avoid', f.avoid]]) {
        for (const r of ranges(slots)) {
          await c.query('INSERT INTO constraints (subject_type, subject_id, kind, day, period_from, period_to, note) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
            'faculty', f.id, kind, r.day, r.from, r.to, 'Demo rule',
          ]);
        }
      }
    }
    for (const s of p.sections) {
      for (const r of ranges(s.unavailable || [])) {
        await c.query('INSERT INTO constraints (subject_type, subject_id, kind, day, period_from, period_to, note) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
          'section', s.id, 'unavailable', r.day, r.from, r.to, 'Sports & clubs hour',
        ]);
      }
    }
    for (const o of p.offerings) {
      await c.query('INSERT INTO offerings (id, course_id, faculty_id) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [o.id, o.courseId, o.facultyId]);
      for (const s of o.sectionIds) await c.query('INSERT INTO offering_sections (offering_id, section_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [o.id, s]);
    }
    for (const b of p.baskets) {
      await c.query('INSERT INTO baskets (id, name, sessions_per_week) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [b.id, b.name, b.sessionsPerWeek]);
      for (const s of b.sectionIds) await c.query('INSERT INTO basket_sections (basket_id, section_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [b.id, s]);
      for (const o of b.options) {
        await c.query('INSERT INTO basket_options (offering_id, basket_id, course_id, faculty_id, size) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [
          o.offeringId, b.id, o.courseId, o.facultyId, o.size,
        ]);
      }
    }
    for (const u of DEMO_USERS) {
      await c.query(
        `INSERT INTO users (name, email, password_hash, role, faculty_id, section_id) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (lower(email)) DO NOTHING`,
        [u.name, u.email, hash, u.role, u.facultyId ?? null, u.sectionId ?? null],
      );
    }
  });
  return { sections: p.sections.length, faculty: p.faculty.length, rooms: p.rooms.length, offerings: p.offerings.length, baskets: p.baskets.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed({ reset: process.argv.includes('--reset') })
    .then((counts) => {
      logger.info('Demo data loaded', counts);
      logger.info(`Demo logins (password ${DEMO_PASSWORD}): ${DEMO_USERS.map((u) => u.email).join(', ')}`);
      return pool.end();
    })
    .catch((err) => {
      logger.error(err.message);
      process.exit(1);
    });
}
