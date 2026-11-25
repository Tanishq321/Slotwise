import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { query } from '../db/pg.js';
import { env } from '../config/env.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { badRequest, conflict, forbidden, unauthorized } from '../utils/errors.js';
import { Timetable } from '../models/Timetable.js';
import { audit } from '../models/AuditLog.js';

export const authRouter = Router();

// Slows down password guessing: 20 attempts per 15 minutes per IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.NODE_ENV === 'test' ? 1000 : 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again in a few minutes' },
});

const email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email'));
const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name is too short').max(80),
  email,
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  sectionId: z.string().trim().min(1).max(80).optional(),
});
const loginSchema = z.object({ email, password: z.string().min(1).max(128) });

export const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, facultyId: u.faculty_id, sectionId: u.section_id });

// Anyone can sign up as a student. The very first account becomes the admin, so a fresh
// install can be set up without touching the database. Admins promote others later.
authRouter.post('/register', loginLimiter, validate({ body: registerSchema }), async (req, res) => {
  const { name, email: mail, password, sectionId } = req.valid.body;
  const exists = await query('SELECT 1 FROM users WHERE lower(email) = $1', [mail]);
  if (exists.rowCount) throw conflict('An account with this email already exists');
  if (sectionId && !(await query('SELECT 1 FROM sections WHERE id = $1', [sectionId])).rowCount) throw badRequest('That class does not exist');
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, role, section_id)
     VALUES ($1, $2, $3, CASE WHEN (SELECT count(*) FROM users) = 0 THEN 'admin' ELSE 'student' END, $4)
     RETURNING *`,
    [name, mail, hash, sectionId ?? null],
  );
  const user = rows[0];
  audit({ id: user.id, name: user.name, role: user.role }, 'register', 'user', user.id);
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

authRouter.post('/login', loginLimiter, validate({ body: loginSchema }), async (req, res) => {
  const { email: mail, password } = req.valid.body;
  const { rows } = await query('SELECT * FROM users WHERE lower(email) = $1', [mail]);
  const user = rows[0];
  // Same message either way, so the form doesn't reveal which emails are registered.
  if (!user || !(await bcrypt.compare(password, user.password_hash))) throw unauthorized('Wrong email or password');
  res.json({ token: signToken(user), user: publicUser(user) });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) throw unauthorized('Account no longer exists');
  res.json({ user: publicUser(rows[0]) });
});

// Class names for the sign-up form and the "choose your class" step (names only, nothing private).
authRouter.get('/classes', async (_req, res) => {
  const { rows } = await query('SELECT id, name, program, semester FROM sections ORDER BY program NULLS LAST, semester NULLS LAST, name');
  res.json({ items: rows });
});

/**
 * A student picks their class once. After that only an admin can change it
 * (People & roles), unless the class no longer exists, e.g. after new data was loaded.
 */
authRouter.patch('/me/section', requireAuth, validate({ body: z.object({ sectionId: z.string().trim().min(1).max(80) }) }), async (req, res) => {
  if (req.user.role !== 'student') throw forbidden('Only students choose a class here');
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const me = rows[0];
  if (!me) throw unauthorized('Account no longer exists');
  if (me.section_id) {
    const published = await Timetable.findPublished().select('problem.sections').lean();
    const stillThere = published ? published.problem.sections.some((s) => s.id === me.section_id) : (await query('SELECT 1 FROM sections WHERE id = $1', [me.section_id])).rowCount;
    if (stillThere) throw forbidden('Your class is already set. Ask your department to change it.');
  }
  const { sectionId } = req.valid.body;
  if (!(await query('SELECT 1 FROM sections WHERE id = $1', [sectionId])).rowCount) throw badRequest('That class does not exist');
  const updated = (await query('UPDATE users SET section_id = $2 WHERE id = $1 RETURNING *', [me.id, sectionId])).rows[0];
  audit(req.user, 'choose', 'their class', me.id, { sectionId });
  res.json({ token: signToken(updated), user: publicUser(updated) });
});
