import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { query } from '../db/pg.js';
import { env } from '../config/env.js';
import { validate } from '../middleware/validate.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { conflict, unauthorized } from '../utils/errors.js';
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
});
const loginSchema = z.object({ email, password: z.string().min(1).max(128) });

export const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, facultyId: u.faculty_id, sectionId: u.section_id });

// Anyone can sign up as a student. The very first account becomes the admin, so a fresh
// install can be set up without touching the database. Admins promote others later.
authRouter.post('/register', loginLimiter, validate({ body: registerSchema }), async (req, res) => {
  const { name, email: mail, password } = req.valid.body;
  const exists = await query('SELECT 1 FROM users WHERE lower(email) = $1', [mail]);
  if (exists.rowCount) throw conflict('An account with this email already exists');
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, CASE WHEN (SELECT count(*) FROM users) = 0 THEN 'admin' ELSE 'student' END)
     RETURNING *`,
    [name, mail, hash],
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
