// Moving one class by hand. Shared by the browser (live drag-and-drop preview) and
// the server (final check before saving), so both apply exactly the same rules.
import { checkTimetable } from './check.js';

const clashKey = (c) => `${c.type}|${c.message}`;
const copy = (events) => events.map((e) => (typeof e.toObject === 'function' ? e.toObject() : structuredClone(e)));
const overlaps = (a, b) => a.day === b.day && a.start != null && b.start != null && a.start < b.start + b.duration && b.start < a.start + a.duration;

function roomFree(events, ev, roomId) {
  return !!roomId && !events.some((o) => o.id !== ev.id && overlaps(o, ev) && o.parts.some((p) => p.roomId === roomId));
}

/** Smallest free room of the right type and size for `part` while `ev` runs. */
export function findFreeRoom(problem, events, ev, part, taken = []) {
  const course = problem.courses.find((c) => c.id === part.courseId);
  const type = course?.type === 'lab' ? 'lab' : 'lecture';
  const busy = new Set(taken);
  for (const o of events) if (o.id !== ev.id && overlaps(o, ev)) for (const p of o.parts) if (p.roomId) busy.add(p.roomId);
  return problem.rooms
    .filter((r) => r.type === type && r.capacity >= (part.size || 0) && !busy.has(r.id))
    .sort((a, b) => a.capacity - b.capacity)[0]?.id;
}

/**
 * Apply a move to a copy of the events. Keeps each room if it's still free at the new
 * time, otherwise picks another suitable room. Reports only clashes the move adds.
 * @returns {{ events, moved, newClashes, allClashes } | null}
 */
export function applyMove(problem, currentEvents, eventId, { day, start, rooms } = {}, baseline) {
  const events = copy(currentEvents);
  const ev = events.find((e) => e.id === eventId);
  if (!ev) return null;
  const before = baseline || new Set(checkTimetable(problem, events).map(clashKey));
  ev.day = day;
  ev.start = start;
  const taken = [];
  for (const part of ev.parts) {
    if (rooms?.[part.offeringId]) part.roomId = rooms[part.offeringId];
    else if (!(roomFree(events, ev, part.roomId) && !taken.includes(part.roomId))) part.roomId = findFreeRoom(problem, events, ev, part, taken) || part.roomId;
    taken.push(part.roomId);
  }
  const allClashes = checkTimetable(problem, events);
  return { events, moved: ev, newClashes: allClashes.filter((c) => !before.has(clashKey(c))), allClashes };
}

/** Baseline clash set, computed once per drag instead of once per target cell. */
export const clashBaseline = (problem, events) => new Set(checkTimetable(problem, events).map(clashKey));
