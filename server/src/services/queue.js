// BullMQ job queue. The API adds a job and returns immediately (202 Accepted);
// a worker picks it up, runs the engine and stores the result in MongoDB.
import { Queue, Worker } from 'bullmq';
import { createRedis } from './redis.js';
import { processGeneration } from './generation.js';
import { logger } from '../utils/logger.js';

const QUEUE_NAME = 'timetable-generation';
let queue;
let worker;
// BullMQ does not close connections it was given, so we track and close them ourselves.
const connections = [];
const conn = () => {
  const c = createRedis();
  connections.push(c);
  return c;
};

export function getQueue() {
  if (!queue) queue = new Queue(QUEUE_NAME, { connection: conn() });
  return queue;
}

export async function enqueueGeneration(timetableId) {
  await getQueue().add(
    'generate',
    { timetableId },
    { jobId: timetableId, attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
  );
}

export function startWorker({ concurrency = 1 } = {}) {
  if (worker) return worker;
  worker = new Worker(QUEUE_NAME, (job) => processGeneration(job.data.timetableId, job), {
    connection: conn(),
    concurrency,
  });
  worker.on('failed', (job, err) => logger.error('Generation job failed', { id: job?.data?.timetableId, err: err.message }));
  worker.on('ready', () => logger.info('Generation worker ready'));
  return worker;
}

export async function closeQueue() {
  await worker?.close();
  await queue?.close();
  await Promise.allSettled(connections.splice(0).map((c) => c.quit()));
  worker = undefined;
  queue = undefined;
}
