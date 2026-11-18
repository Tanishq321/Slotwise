// Starts the API: connect databases, apply migrations, listen, and shut down cleanly.
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { connectMongo, disconnectMongo } from './db/mongo.js';
import { pool } from './db/pg.js';
import { migrate } from './db/migrate.js';
import { redis } from './services/redis.js';
import { startWorker, closeQueue } from './services/queue.js';

async function main() {
  await migrate();
  await connectMongo();
  if (env.RUN_WORKER_IN_API) startWorker();

  const server = createApp().listen(env.PORT, () => logger.info(`Slotwise API listening on http://localhost:${env.PORT}`));

  const shutdown = async (signal) => {
    logger.info(`${signal} received, shutting down`);
    server.close();
    await closeQueue().catch(() => {});
    await Promise.allSettled([disconnectMongo(), pool.end(), redis.quit()]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('Failed to start', { err: err.message, stack: err.stack });
  process.exit(1);
});
