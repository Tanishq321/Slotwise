// Manual edits. The move logic itself lives in the engine package (engine/src/move.js)
// so the browser's drag-and-drop preview and the server use the very same rules.
import { applyMove as engineMove, scoreTimetable } from '@samay/engine';

/** Returns { events, moved, newClashes, allClashes, score } or null. Saves nothing. */
export function applyMove(problem, currentEvents, eventId, move) {
  const result = engineMove(problem, currentEvents, eventId, move);
  if (!result) return null;
  result.moved.editedAt = new Date();
  return { ...result, score: result.allClashes.length ? null : scoreTimetable(problem, result.events) };
}

/** Which events a person should see: a section's classes, a teacher's, or a room's. */
export function filterEvents(events, type, id) {
  if (!type || !id) return events;
  if (type === 'section') return events.filter((e) => e.sectionIds.includes(id));
  const key = type === 'faculty' ? 'facultyId' : 'roomId';
  return events.filter((e) => e.parts.some((p) => p[key] === id)).map((e) => ({ ...e, parts: e.parts.filter((p) => p[key] === id) }));
}
