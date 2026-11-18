import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });
}

// Central error handler: every thrown error ends up here and becomes clean JSON.
export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, ...(err.details ? { details: err.details } : {}) });
  }
  // PostgreSQL error codes → friendly messages.
  if (err.code === '23505') return res.status(409).json({ error: 'That already exists (duplicate value)', detail: err.detail });
  if (err.code === '23503') return res.status(409).json({ error: 'This item is linked to other data, remove those links first', detail: err.detail });
  if (err.code === '23514') return res.status(400).json({ error: 'A value is out of the allowed range', detail: err.detail });
  if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid id' });
  if (err.name === 'MulterError') return res.status(400).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });

  logger.error('Unhandled error', { method: req.method, url: req.originalUrl, err: err.message, stack: err.stack });
  return res.status(500).json({ error: 'Something went wrong on our side' });
}
