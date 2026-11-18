// All configuration comes from environment variables (see .env.example).
// Validating them at startup gives a clear error instead of a confusing crash later.
import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().default('postgres://slotwise:slotwise@localhost:5432/slotwise'),
  MONGO_URL: z.string().default('mongodb://localhost:27017/slotwise'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters').default('dev-only-secret-change-me-please'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('openai/gpt-oss-20b'),
  // Free hosting (e.g. Render) has no free background workers, so the API can run the
  // queue worker itself. In bigger deployments run `npm run worker` separately instead.
  RUN_WORKER_IN_API: bool.default(true),
  GENERATION_TIME_LIMIT_SEC: z.coerce.number().min(2).max(120).default(15),
  LOG_LEVEL: z.string().default('info'),
  // true = load the demo department and logins at startup if the demo admin is missing.
  // Handy on hosts without a terminal (e.g. Render's free plan). Remove it afterwards.
  SEED_DEMO: bool.default(false),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(` - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const env = parsed.data;
if (env.NODE_ENV === 'production' && env.JWT_SECRET.startsWith('dev-only')) {
  console.error('Set a real JWT_SECRET in production.');
  process.exit(1);
}
