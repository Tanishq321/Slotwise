// Phase 1 — build a clash-free timetable.
//
// Strategy (a graph-colouring heuristic with "ejection chains"):
//  1. Always place the most constrained class next — the one with the fewest legal slots
//     left (like DSatur graph colouring, where time slots are the "colours").
//  2. If a class has no legal slot, put it in the slot that clashes with the fewest
//     already-placed classes, kick those out, and put them back in the queue.
//  3. Classes that keep getting kicked out become "expensive" to evict, which stops
//     the search going round in circles.

export function construct(c, state, rng, { maxSteps, onProgress, deadline } = {}) {
  const E = c.events.length;
  const steps = maxSteps ?? Math.max(5000, E * 60);
  const evictions = new Int32Array(E);
  const domain = new Int32Array(E);
  const unplaced = new Set();
  const impossible = [];
  for (let e = 0; e < E; e++) if (!state.isPlaced(e)) unplaced.add(e);

  const countDomain = (e) => {
    let n = 0;
    for (const [d, t] of state.positions(c.events[e])) if (state.canPlace(e, d, t)) n++;
    return n;
  };
  for (const e of unplaced) domain[e] = countDomain(e);

  const refreshAround = (e) => {
    for (const x of c.events[e].neighbors) if (unplaced.has(x)) domain[x] = countDomain(x);
  };

  // Shortest class each section still has to place: a free stretch shorter than this is wasted.
  const minLeft = new Int16Array(c.S);
  const refreshMinLeft = () => {
    minLeft.fill(99);
    for (const x of unplaced) for (const s of c.events[x].groups) minLeft[s] = Math.min(minLeft[s], c.events[x].duration);
  };
  refreshMinLeft();
  let sinceRefresh = 0;

  // Free stretches in a section's day that become too short to hold any remaining class
  // if `ev` is placed at (d, t). Tight weeks fail mostly because of these leftover holes.
  const wastedAfter = (s, d, t, dur) => {
    const base = (s * c.D + d) * c.P;
    const need = minLeft[s];
    if (need <= 1 || need === 99) return 0;
    let wasted = 0;
    let run = 0;
    for (let p = 0; p <= c.P; p++) {
      const free = p < c.P && !(p >= t && p < t + dur) && state.secOcc[base + p] < 0 && !c.isBreak[p] && !c.secUnavail[base + p];
      if (free) run++;
      else {
        if (run > 0 && run < need) wasted += run;
        run = 0;
      }
    }
    return wasted;
  };

  // Cheap placement preference: keep section days compact, avoid leaving unusable holes
  // and avoid disliked slots.
  const prefer = (e, d, t) => {
    const ev = c.events[e];
    let score = rng.next() * 0.6;
    for (const s of ev.groups) {
      score += wastedAfter(s, d, t, ev.duration) * 3;
      const base = (s * c.D + d) * c.P;
      let load = 0;
      for (let p = 0; p < c.P; p++) if (state.secOcc[base + p] >= 0) load++;
      score += load * 0.8;
      const before = t - 1 >= 0 && state.secOcc[base + t - 1] >= 0;
      const after = t + ev.duration < c.P && state.secOcc[base + t + ev.duration] >= 0;
      if (before || after) score -= 1.2;
      if (t + ev.duration === c.P) score += 1;
    }
    for (const f of ev.facs) for (let p = t; p < t + ev.duration; p++) if (c.facAvoid[(f * c.D + d) * c.P + p]) score += 4;
    return score;
  };

  let best = { count: Infinity, snap: null };
  let step = 0;
  let lastReport = 0;
  while (unplaced.size > 0 && step < steps) {
    if (deadline && step % 64 === 0 && Date.now() > deadline) break;
    step++;
    if (++sinceRefresh >= 25) {
      refreshMinLeft();
      sinceRefresh = 0;
    }
    // Pick the most constrained unplaced class.
    let e = -1;
    let bestKey = Infinity;
    for (const x of unplaced) {
      const key = domain[x] * 1000 - c.events[x].difficulty * 10 + evictions[x] * -5 + rng.next();
      if (key < bestKey) {
        bestKey = key;
        e = x;
      }
    }
    const ev = c.events[e];
    let bestPos = null;
    let bestScore = Infinity;
    for (const [d, t] of state.positions(ev)) {
      const rooms = state.canPlace(e, d, t);
      if (!rooms) continue;
      const sc = prefer(e, d, t);
      if (sc < bestScore) {
        bestScore = sc;
        bestPos = [d, t, rooms];
      }
    }
    if (bestPos) {
      state.place(e, bestPos[0], bestPos[1], bestPos[2]);
      unplaced.delete(e);
      refreshAround(e);
    } else {
      // No free slot: evict the cheapest set of clashing classes.
      let choice = null;
      let choiceCost = Infinity;
      for (const [d, t] of state.positions(ev)) {
        const set = state.conflictsFor(e, d, t);
        if (!set) continue;
        let cost = rng.next() * 0.5;
        for (const x of set) cost += 1 + evictions[x] * 0.7;
        if (cost < choiceCost) {
          choiceCost = cost;
          choice = [d, t, set];
        }
      }
      if (!choice) {
        // This class can never be placed (e.g. not enough suitable rooms exist at once).
        // Give up on it alone and keep scheduling everything else.
        unplaced.delete(e);
        impossible.push(e);
        continue;
      }
      const [d, t, set] = choice;
      for (const x of set) {
        state.unplace(x);
        unplaced.add(x);
        evictions[x]++;
      }
      const rooms = state.canPlace(e, d, t);
      if (rooms) {
        state.place(e, d, t, rooms);
        unplaced.delete(e);
      }
      for (const x of set) domain[x] = countDomain(x);
      refreshAround(e);
      for (const x of set) refreshAround(x);
    }
    if (unplaced.size + impossible.length < best.count) {
      const count = unplaced.size + impossible.length;
      best = { count, snap: count === 0 ? null : state.snapshot() };
    }
    if (onProgress && step - lastReport >= 200) {
      lastReport = step;
      onProgress({ phase: 'construct', placed: E - unplaced.size - impossible.length, total: E });
    }
  }

  if (unplaced.size + impossible.length > 0 && best.snap && best.count < unplaced.size + impossible.length) state.restore(best.snap);
  const remaining = [];
  for (let e = 0; e < E; e++) if (!state.isPlaced(e)) remaining.push(e);
  const totalEvictions = evictions.reduce((a, b) => a + b, 0);
  return { steps: step, evictions: totalEvictions, unplaced: remaining };
}
