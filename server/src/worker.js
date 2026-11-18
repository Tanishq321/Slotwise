// Standalone generation worker (`npm run worker`). Use this when the API runs with
// RUN_WORKER_IN_API=false, so heavy timetable jobs never slow down API requests and
// you can run several workers side by side.
import { logger } from './utils/logger.js';
import { connectMongo, disconnectMongo } from './db/mongo.js';
import { redis } from './services/redis.js';
import { startWorker, closeQueue } from './services/queue.js';

await connectMongo();
startWorker({ concurrency: Number(process.env.WORKER_CONCURRENCY || 1) });
logger.info('Slotwise worker started');

const shutdown = async () => {
  await closeQueue().catch(() => {});
  await Promise.allSettled([disconnectMongo(), redis.quit()]);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
