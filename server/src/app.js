// Builds the Express app. Kept separate from index.js (which opens ports and
// connections) so tests can import the app and call it with supertest.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { rateLimit } from 'express-rate-limit';
import { env } from './config/env.js';
import { httpLogStream } from './utils/logger.js';
import { notFoundHandler, errorHandler } from './middleware/error.js';
import { apiRouter } from './routes/index.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Render/Vercel sit behind a proxy; needed for correct client IPs
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
      credentials: false,
      exposedHeaders: ['Content-Disposition', 'X-Cache'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  if (env.NODE_ENV !== 'test') app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev', { stream: httpLogStream }));

  // A broad safety net; stricter limits sit on login and the AI endpoint.
  app.use('/api', rateLimit({ windowMs: 60_000, limit: env.NODE_ENV === 'test' ? 10_000 : 300, standardHeaders: 'draft-8', legacyHeaders: false }));

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'samay-api', time: new Date().toISOString() }));
  app.use('/api', apiRouter);

  // In production the API also serves the built React app, so the whole project runs
  // as one service on one URL (no CORS setup). Vite serves it during development.
  const clientDist = fileURLToPath(new URL('../../client/dist/', import.meta.url));
  if (env.NODE_ENV === 'production' && existsSync(`${clientDist}index.html`)) {
    app.use('/assets', express.static(`${clientDist}assets`, { immutable: true, maxAge: '1y' }));
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    // Any other non-API path is a page of the single-page app.
    app.get(/^(?!\/api\/|\/health$).*/, (_req, res) => res.sendFile(`${clientDist}index.html`));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
