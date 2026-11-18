// Timetable analytics: faculty load, room utilisation and classes per day.
//
// The numbers come from MongoDB's aggregation pipeline ($unwind the embedded events
// and their parts, then $group). Some MongoDB-compatible databases (e.g. FerretDB v1,
// handy for local development) don't fully support nested $unwind, so the result is
// sanity-checked; if it doesn't add up, the same numbers are computed in app code.
import mongoose from 'mongoose';
import { Timetable } from '../models/Timetable.js';
import { logger } from '../utils/logger.js';

let warned = false;

async function viaPipeline(_id) {
  const base = [{ $match: { _id } }, { $unwind: '$events' }, { $match: { 'events.day': { $ne: null } } }];
  const [byFaculty, byRoom, byDay] = await Promise.all([
    Timetable.aggregate([...base, { $unwind: '$events.parts' }, { $group: { _id: '$events.parts.facultyId', periods: { $sum: '$events.duration' }, classes: { $sum: 1 } } }]),
    Timetable.aggregate([...base, { $unwind: '$events.parts' }, { $group: { _id: '$events.parts.roomId', periods: { $sum: '$events.duration' } } }]),
    Timetable.aggregate([...base, { $group: { _id: '$events.day', periods: { $sum: '$events.duration' }, classes: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
  ]);
  return { byFaculty, byRoom, byDay };
}

export function viaApp(events) {
  const add = (map, key, periods, classes = 0) => {
    const cur = map.get(key) || { _id: key, periods: 0, classes: 0 };
    cur.periods += periods;
    cur.classes += classes;
    map.set(key, cur);
  };
  const fac = new Map();
  const room = new Map();
  const day = new Map();
  for (const ev of events) {
    if (ev.day == null) continue;
    add(day, ev.day, ev.duration, 1);
    for (const p of ev.parts) {
      add(fac, p.facultyId, ev.duration, 1);
      add(room, p.roomId, ev.duration);
    }
  }
  return { byFaculty: [...fac.values()], byRoom: [...room.values()], byDay: [...day.values()].sort((a, b) => a._id - b._id) };
}

const sum = (rows, k) => rows.reduce((n, r) => n + (r[k] || 0), 0);

export async function timetableAnalytics(id) {
  const _id = new mongoose.Types.ObjectId(id);
  const tt = await Timetable.findById(_id).select('problem events').lean();
  if (!tt) return null;

  let data = await viaPipeline(_id);
  let source = 'mongodb-aggregation';
  const scheduled = tt.events.filter((e) => e.day != null);
  const expectedDayPeriods = scheduled.reduce((n, e) => n + e.duration, 0);
  const expectedPartPeriods = scheduled.reduce((n, e) => n + e.duration * e.parts.length, 0);
  const consistent =
    sum(data.byDay, 'periods') === expectedDayPeriods &&
    sum(data.byDay, 'classes') === scheduled.length &&
    sum(data.byFaculty, 'periods') === expectedPartPeriods &&
    sum(data.byRoom, 'periods') === expectedPartPeriods;
  if (!consistent) {
    if (!warned) {
      logger.warn('Aggregation result did not add up (database lacks full $unwind/$group support); computing analytics in the app instead');
      warned = true;
    }
    data = viaApp(tt.events);
    source = 'app';
  }

  const { config, faculty, rooms } = tt.problem;
  const teachable = config.periodsPerDay - (config.breaks || []).length;
  const weekSlots = config.days.length * teachable;
  const fac = new Map(data.byFaculty.map((x) => [x._id, x]));
  const room = new Map(data.byRoom.map((x) => [x._id, x]));
  const day = new Map(data.byDay.map((x) => [x._id, x]));
  return {
    source,
    weekSlots,
    faculty: faculty
      .map((f) => ({ id: f.id, name: f.name, periods: fac.get(f.id)?.periods || 0, classes: fac.get(f.id)?.classes || 0, maxPerWeek: f.maxPerWeek ?? null }))
      .sort((a, b) => b.periods - a.periods || a.name.localeCompare(b.name)),
    rooms: rooms
      .map((r) => {
        const periods = room.get(r.id)?.periods || 0;
        return { id: r.id, name: r.name, type: r.type, capacity: r.capacity, periods, utilisation: Math.round((periods / weekSlots) * 100) };
      })
      .sort((a, b) => b.utilisation - a.utilisation || a.name.localeCompare(b.name)),
    days: config.days.map((name, d) => ({ day: d, name, periods: day.get(d)?.periods || 0, classes: day.get(d)?.classes || 0 })),
  };
}
