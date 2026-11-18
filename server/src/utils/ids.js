import { randomBytes } from 'node:crypto';

// Short readable ids like "fac-k3x9q2" (the engine works with string ids).
export const newId = (prefix) => `${prefix}-${randomBytes(4).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) || Date.now().toString(36)}`;
