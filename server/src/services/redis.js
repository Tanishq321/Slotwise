// Redis does three jobs here:
//  1. the BullMQ job queue for timetable generation,
//  2. a cache for finished timetables (they are read far more often than written),
//  3. a per-user rate limit for the AI endpoint.
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

// BullMQ requires maxRetriesPerRequest: null on its connections.
export const createRedis = (extra = {}) =>
  new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false, ...extra });

export const redis = createRedis();
redis.on('error', (err) => logger.error('Redis error', { err: err.message }));

const CACHE_PREFIX = 'slotwise:cache:';

export async function cacheGet(key) {
  try {
    const raw = await redis.get(CACHE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // a cache problem should never break a request
  }
}

export async function cacheSet(key, value, ttlSeconds = 600) {
  try {
    await redis.set(CACHE_PREFIX + key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    /* ignore */
  }
}

export async function cacheDel(...keys) {
  try {
    if (keys.length) await redis.del(...keys.map((k) => CACHE_PREFIX + k));
  } catch {
    /* ignore */
  }
}

/** Fixed-window rate limit. Returns { allowed, remaining, resetIn }. */
export async function rateLimit(key, limit, windowSeconds) {
  const k = `slotwise:rl:${key}`;
  const count = await redis.incr(k);
  if (count === 1) await redis.expire(k, windowSeconds);
  const ttl = await redis.ttl(k);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetIn: ttl };
}
