import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { forbidden, unauthorized } from '../utils/errors.js';

export const signToken = (user) =>
  jwt.sign({ sub: user.id, name: user.name, role: user.role, facultyId: user.faculty_id ?? null, sectionId: user.section_id ?? null }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  });

/** Requires a valid "Authorization: Bearer <token>" header and puts the user on req.user. */
export function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized());
  try {
    const p = jwt.verify(token, env.JWT_SECRET);
    req.user = { id: p.sub, name: p.name, role: p.role, facultyId: p.facultyId, sectionId: p.sectionId };
    return next();
  } catch {
    return next(unauthorized('Your session has expired, please log in again'));
  }
}

/** Role-based access control, e.g. requireRole('admin', 'hod'). */
export const requireRole =
  (...roles) =>
  (req, _res, next) =>
    roles.includes(req.user?.role) ? next() : next(forbidden());

export const canEdit = requireRole('admin', 'hod');
