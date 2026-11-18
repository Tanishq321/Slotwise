// MongoDB stores generated timetables. Each version is one self-contained document
// (embedding): its events plus a snapshot of the input it was generated from, so an
// old version still makes sense even after someone renames a room in Postgres.
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

export async function connectMongo() {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGO_URL, { serverSelectionTimeoutMS: 8000 });
  logger.info('MongoDB connected');
  return mongoose.connection;
}

export const disconnectMongo = () => mongoose.disconnect();
