// Phase 2 — make the clash-free timetable *better* with simulated annealing.
//
// We repeatedly try a small random change (move one class, or swap two classes of the
// same section). Changes that break a hard rule are rejected immediately. Changes that
// improve the soft cost are kept; changes that make it worse are sometimes kept too —
// with a probability that shrinks as the "temperature" cools — so the search can
// escape local minima early on and settle down later.

import { sectionCost, facultyCost } from './cost.js';

export function anneal(c, state, rng, { timeLimitMs = 3000, maxIters = Infinity, onProgress, t0 = 4, tEnd = 0.05 } = {}) {
  const E = c.events.length;
  const placed = [];
  for (let e = 0; e < E; e++) if (state.isPlaced(e)) placed.push(e);
  if (placed.length === 0) return { iterations: 0, accepted: 0, initialCost: 0, finalCost: 0 };

  const secCost = new Float64Array(c.S);
  const facCost = new Float64Array(c.F);
  let current = 0;
  for (let s = 0; s < c.S; s++) current += secCost[s] = sectionCost(state, s);
  for (let f = 0; f < c.F; f++) current += facCost[f] = facultyCost(state, f);
  const initialCost = current;
  let best = current;
  let bestSnap = null;
  let bestDirty = false;

  const affected = (events) => {
    const secs = new Set();
    const facs = new Set();
    for (const e of events) {
      for (const s of c.events[e].groups) secs.add(s);
      for (const f of c.events[e].facs) facs.add(f);
    }
    return [secs, facs];
  };
  const before = (secs, facs) => {
    let sum = 0;
    for (const s of secs) sum += secCost[s];
    for (const f of facs) sum += facCost[f];
    return sum;
  };
  const after = (secs, facs, write) => {
    let sum = 0;
    for (const s of secs) {
      const v = sectionCost(state, s);
      sum += v;
      if (write) secCost[s] = v;
    }
    for (const f of facs) {
      const v = facultyCost(state, f);
      sum += v;
      if (write) facCost[f] = v;
    }
    return sum;
  };

  const start = Date.now();
  let iter = 0;
  let accepted = 0;
  let temp = t0;
  let lastReport = start;
  while (iter < maxIters) {
    if ((iter & 255) === 0) {
      const elapsed = Date.now() - start;
      if (elapsed >= timeLimitMs) break;
      const progress = Math.min(1, Math.max(elapsed / timeLimitMs, Number.isFinite(maxIters) ? iter / maxIters : 0));
      temp = t0 * Math.pow(tEnd / t0, progress);
      if (onProgress && Date.now() - lastReport > 200) {
        lastReport = Date.now();
        onProgress({ phase: 'optimise', progress, cost: Math.round(current * 10) / 10, best: Math.round(best * 10) / 10 });
      }
    }
    iter++;
    const e = placed[rng.int(placed.length)];
    const ev = c.events[e];
    const old = [state.day[e], state.start[e], state.rooms[e]];

    if (rng.next() < 0.6) {
      // Move one class to a random legal slot.
      const positions = state.positions(ev);
      const [d, t] = positions[rng.int(positions.length)];
      if (d === old[0] && t === old[1]) continue;
      const [secs, facs] = affected([e]);
      const b = before(secs, facs);
      state.unplace(e);
      const rooms = state.canPlace(e, d, t);
      if (!rooms) {
        state.place(e, old[0], old[1], old[2]);
        continue;
      }
      state.place(e, d, t, rooms);
      const a = after(secs, facs, false);
      const delta = a - b;
      if (delta <= 0 || rng.next() < Math.exp(-delta / temp)) {
        after(secs, facs, true);
        current += delta;
        accepted++;
      } else {
        state.unplace(e);
        state.place(e, old[0], old[1], old[2]);
      }
    } else {
      // Swap two classes that share a section and have the same length.
      const s = ev.groups[rng.int(ev.groups.length)];
      const pool = c.secEvents[s];
      const e2 = pool[rng.int(pool.length)];
      if (e2 === e || !state.isPlaced(e2) || c.events[e2].duration !== ev.duration) continue;
      const old2 = [state.day[e2], state.start[e2], state.rooms[e2]];
      if (old2[0] === old[0] && old2[1] === old[1]) continue;
      const [secs, facs] = affected([e, e2]);
      const b = before(secs, facs);
      state.unplace(e);
      state.unplace(e2);
      const r1 = state.canPlace(e, old2[0], old2[1]);
      if (r1) state.place(e, old2[0], old2[1], r1);
      const r2 = r1 ? state.canPlace(e2, old[0], old[1]) : null;
      if (!r1 || !r2) {
        if (r1) state.unplace(e);
        state.place(e, old[0], old[1], old[2]);
        state.place(e2, old2[0], old2[1], old2[2]);
        continue;
      }
      state.place(e2, old[0], old[1], r2);
      const a = after(secs, facs, false);
      const delta = a - b;
      if (delta <= 0 || rng.next() < Math.exp(-delta / temp)) {
        after(secs, facs, true);
        current += delta;
        accepted++;
      } else {
        state.unplace(e);
        state.unplace(e2);
        state.place(e, old[0], old[1], old[2]);
        state.place(e2, old2[0], old2[1], old2[2]);
      }
    }

    if (current < best - 1e-9) {
      best = current;
      bestDirty = true;
    }
    // Snapshot the best state occasionally (copying every time would be slow).
    if (bestDirty && (iter & 1023) === 0 && current <= best + 1e-9) {
      bestSnap = state.snapshot();
      bestDirty = false;
    }
  }
  if (bestSnap && current > best + 1e-9) {
    // Only roll back if the saved snapshot really is the best one we kept.
    const snapCost = recompute(state, bestSnap);
    if (snapCost < current) {
      state.restore(bestSnap);
      current = snapCost;
    }
  }
  return { iterations: iter, accepted, initialCost: round(initialCost), finalCost: round(current) };
}

function recompute(state, snap) {
  const saved = state.snapshot();
  state.restore(snap);
  let sum = 0;
  for (let s = 0; s < state.c.S; s++) sum += sectionCost(state, s);
  for (let f = 0; f < state.c.F; f++) sum += facultyCost(state, f);
  state.restore(saved);
  return sum;
}

const round = (x) => Math.round(x * 10) / 10;
