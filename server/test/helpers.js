// Integration tests run against real services, using separate test databases:
// PostgreSQL "slotwise_test", MongoDB "slotwise_test" and Redis database 1.
// Environment variables must be set before any app module is imported.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://slotwise:slotwise@localhost:5432/slotwise_test';
process.env.MONGO_URL = process.env.TEST_MONGO_URL || 'mongodb://localhost:27017/slotwise_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379/1';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
process.env.GROQ_API_KEY = '';
process.env.RUN_WORKER_IN_API = 'true';

export async function startTestApp() {
  const [{ createApp }, { pool }, { migrate }, { connectMongo }, { redis }, { startWorker }] = await Promise.all([
    import('../src/app.js'),
    import('../src/db/pg.js'),
    import('../src/db/migrate.js'),
    import('../src/db/mongo.js'),
    import('../src/services/redis.js'),
    import('../src/services/queue.js'),
  ]);
  // Fresh, empty databases for every test file.
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  const conn = await connectMongo();
  await conn.db.dropDatabase();
  await redis.flushdb();
  startWorker();
  return createApp();
}

export async function stopTestApp() {
  const [{ pool }, { disconnectMongo }, { redis }, { closeQueue }] = await Promise.all([
    import('../src/db/pg.js'),
    import('../src/db/mongo.js'),
    import('../src/services/redis.js'),
    import('../src/services/queue.js'),
  ]);
  await closeQueue();
  await Promise.allSettled([pool.end(), disconnectMongo(), redis.quit()]);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
