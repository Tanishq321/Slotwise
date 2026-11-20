import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pg.js';
import { canEdit } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { getSettings } from '../services/problemBuilder.js';
import { badRequest } from '../utils/errors.js';
import { audit } from '../models/AuditLog.js';
import { cacheDel } from '../services/redis.js';

export const settingsRouter = Router();

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');
export const settingsSchema = z
  .object({
    institution: z.string().trim().min(1).max(120),
    days: z.array(z.string().trim().min(1).max(12)).min(1).max(7),
    periodsPerDay: z.number().int().min(1).max(16),
    breaks: z.array(z.number().int().min(0)).max(6).default([]),
    labDuration: z.number().int().min(1).max(4).default(2),
    periodTimes: z.array(z.object({ start: hhmm, end: hhmm, label: z.string().trim().max(30).optional() })).default([]),
    termStart: z.iso.date().nullable().optional(),
    termWeeks: z.number().int().min(1).max(52).default(16),
  })
  .refine((s) => s.breaks.every((b) => b < s.periodsPerDay), { message: 'A break is outside the day', path: ['breaks'] })
  .refine((s) => !s.periodTimes.length || s.periodTimes.length === s.periodsPerDay, {
    message: 'Give a start/end time for every period (or none)',
    path: ['periodTimes'],
  });

settingsRouter.get('/', async (_req, res) => {
  res.json({ settings: await getSettings() });
});

settingsRouter.put('/', canEdit, validate({ body: settingsSchema }), async (req, res) => {
  const s = req.valid.body;
  if (s.periodTimes.some((p) => p.start >= p.end)) throw badRequest('Each period must end after it starts');
  await query(
    `INSERT INTO settings (id, institution, days, periods_per_day, breaks, lab_duration, period_times, term_start, term_weeks)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET institution = $1, days = $2, periods_per_day = $3, breaks = $4,
       lab_duration = $5, period_times = $6, term_start = $7, term_weeks = $8`,
    [s.institution, JSON.stringify(s.days), s.periodsPerDay, JSON.stringify(s.breaks), s.labDuration, JSON.stringify(s.periodTimes), s.termStart ?? null, s.termWeeks],
  );
  await cacheDel('stats');
  audit(req.user, 'update', 'settings', 1);
  res.json({ settings: await getSettings() });
});
