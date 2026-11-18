// Structured logging with Winston: JSON in production (easy to search in log tools),
// readable colours in development.
import winston from 'winston';
import { env } from '../config/env.js';

const { combine, timestamp, json, colorize, printf, errors } = winston.format;

const devFormat = printf(({ level, message, timestamp: ts, ...meta }) => {
  const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} ${level} ${message}${extra}`;
});

export const logger = winston.createLogger({
  level: env.NODE_ENV === 'test' ? 'warn' : env.LOG_LEVEL,
  format: combine(errors({ stack: true }), timestamp(), env.NODE_ENV === 'production' ? json() : combine(colorize(), devFormat)),
  defaultMeta: { service: 'samay-api' },
  transports: [new winston.transports.Console()],
});

// Lets morgan (HTTP access logs) write through winston.
export const httpLogStream = { write: (line) => logger.info(line.trim()) };
