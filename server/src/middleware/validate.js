// Validates and sanitises input with zod. Unknown fields are stripped, strings are
// trimmed by the schemas, and the clean values are placed on req.valid.
import { badRequest } from '../utils/errors.js';

export const validate =
  ({ body, query, params } = {}) =>
  (req, _res, next) => {
    req.valid = req.valid || {};
    for (const [where, schema] of [['body', body], ['query', query], ['params', params]]) {
      if (!schema) continue;
      const result = schema.safeParse(req[where] ?? {});
      if (!result.success) {
        const details = result.error.issues.map((i) => ({ field: i.path.join('.') || where, message: i.message }));
        return next(badRequest(`Invalid ${where}: ${details.map((d) => `${d.field} — ${d.message}`).join('; ')}`, details));
      }
      req.valid[where] = result.data;
    }
    return next();
  };
