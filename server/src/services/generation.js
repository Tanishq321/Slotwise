// What the queue worker does for one "generate timetable" job.
import { Timetable } from '../models/Timetable.js';
import { runEngine, toPercent } from './engineRunner.js';
import { cacheDel } from './redis.js';
import { logger } from '../utils/logger.js';

export async function processGeneration(timetableId, job) {
  const tt = await Timetable.findById(timetableId);
  if (!tt) throw new Error(`Timetable ${timetableId} not found`);
  tt.status = 'running';
  tt.progress = { phase: 'construct', percent: 1, message: 'Placing classes without clashes…' };
  await tt.save();

  let lastWrite = 0;
  const onProgress = (p) => {
    const now = Date.now();
    if (now - lastWrite < 400) return; // don't hammer the database
    lastWrite = now;
    const percent = toPercent(p);
    const message = p.phase === 'construct' ? `Placed ${p.placed} of ${p.total} classes` : `Improving quality (score ${p.best})`;
    job?.updateProgress(percent).catch(() => {});
    Timetable.updateOne({ _id: timetableId }, { progress: { phase: p.phase, percent, message } }).catch(() => {});
  };

  try {
    const result = await runEngine(tt.problem, { seed: tt.seed, timeLimitMs: tt.timeLimitSec * 1000 }, onProgress);
    if (result.status === 'invalid') {
      Object.assign(tt, { status: 'failed', error: 'The input data has problems', validationErrors: result.errors, progress: { phase: 'failed', percent: 100 } });
    } else {
      Object.assign(tt, {
        status: 'done',
        events: result.events,
        unplaced: result.unplaced,
        score: result.score,
        stats: result.stats,
        seed: result.seed,
        progress: {
          phase: 'done',
          percent: 100,
          message: result.unplaced.length ? `${result.unplaced.length} classes could not be placed` : 'All classes placed with zero clashes',
        },
      });
    }
    await tt.save();
    logger.info('Timetable generated', { id: timetableId, status: tt.status, ms: result.stats?.totalMs });
  } catch (err) {
    await Timetable.updateOne({ _id: timetableId }, { status: 'failed', error: err.message, progress: { phase: 'failed', percent: 100 } });
    throw err;
  } finally {
    await cacheDel(`timetable:${timetableId}`);
  }
}
