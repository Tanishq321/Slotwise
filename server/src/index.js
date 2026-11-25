// Starts the API: connect databases, apply migrations, listen, and shut down cleanly.
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { connectMongo, disconnectMongo } from './db/mongo.js';
import { pool } from './db/pg.js';
import { migrate } from './db/migrate.js';
import { seed, DEMO_USERS, DEMO_PASSWORD } from './db/seed.js';
import { redis } from './services/redis.js';
import { startWorker, closeQueue } from './services/queue.js';
import { loadDatasetOnDeploy } from './services/datasetLoader.js';

async function main() {
  await migrate();
  if (env.SEED_DEMO) await seedDemoIfMissing();
  await connectMongo();
  if (env.LOAD_DATASET && env.LOAD_DATASET !== 'none') await loadDatasetOnDeploy(env.LOAD_DATASET);
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

// Loads the demo data once: only when the demo admin account doesn't exist yet, so
// leaving SEED_DEMO on never wipes data again after the first successful run.
async function seedDemoIfMissing() {
  const { rows } = await pool.query('SELECT 1 FROM users WHERE lower(email) = $1', [DEMO_USERS[0].email]);
  if (rows.length) return logger.info('SEED_DEMO is on, but the demo data is already loaded; skipping');
  const counts = await seed({ reset: true });
  logger.info('Demo data loaded (SEED_DEMO=true). You can now remove the SEED_DEMO setting.', counts);
  logger.info(`Demo logins (password ${DEMO_PASSWORD}): ${DEMO_USERS.map((u) => u.email).join(', ')}`);
}
