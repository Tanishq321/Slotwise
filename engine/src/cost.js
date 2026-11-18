// Soft constraints: things that make a timetable *nicer* but are allowed to happen.
// Lower cost = better timetable. Hard constraints never appear here because the
// solver never creates a clash in the first place.

export const WEIGHTS = {
  studentGap: 3, // idle period between two classes of a section
  singleClassDay: 2, // a section comes in for just one class
  lateClass: 1, // class in the last period of the day
  dayImbalance: 1, // uneven spread of a section's load across the week
  facultyAvoid: 5, // teacher asked not to teach in this slot
  facultyGap: 1, // idle period between two classes of a teacher
};

function dayRunCost(occ, base, P, isBreak) {
  // Returns [busy, gaps, late] for one entity on one day.
  let first = -1;
  let last = -1;
  let busy = 0;
  for (let p = 0; p < P; p++) {
    if (occ[base + p] >= 0) {
      if (first < 0) first = p;
      last = p;
      busy++;
    }
  }
  if (busy === 0) return [0, 0, 0];
  let breaksInside = 0;
  for (let p = first; p <= last; p++) if (isBreak[p]) breaksInside++;
  const gaps = last - first + 1 - busy - breaksInside;
  const late = occ[base + P - 1] >= 0 ? 1 : 0;
  return [busy, gaps, late];
}

export function sectionCost(state, s, breakdown) {
  const { D, P, isBreak } = state.c;
  let gaps = 0;
  let singles = 0;
  let late = 0;
  let total = 0;
  const loads = new Array(D);
  for (let d = 0; d < D; d++) {
    const [busy, g, l] = dayRunCost(state.secOcc, (s * D + d) * P, P, isBreak);
    loads[d] = busy;
    total += busy;
    gaps += g;
    late += l;
    if (busy === 1) singles++;
  }
  const mean = total / D;
  let imbalance = 0;
  for (let d = 0; d < D; d++) imbalance += (loads[d] - mean) ** 2;
  imbalance = Math.round(imbalance * 10) / 10;
  if (breakdown) {
    breakdown.studentGaps += gaps;
    breakdown.singleClassDays += singles;
    breakdown.lateClasses += late;
    breakdown.dayImbalance += imbalance;
  }
  return gaps * WEIGHTS.studentGap + singles * WEIGHTS.singleClassDay + late * WEIGHTS.lateClass + imbalance * WEIGHTS.dayImbalance;
}

export function facultyCost(state, f, breakdown) {
  const { D, P, isBreak, facAvoid } = state.c;
  let avoid = 0;
  let gaps = 0;
  for (let d = 0; d < D; d++) {
    const base = (f * D + d) * P;
    for (let p = 0; p < P; p++) if (facAvoid[base + p] && state.facOcc[base + p] >= 0) avoid++;
    gaps += dayRunCost(state.facOcc, base, P, isBreak)[1];
  }
  if (breakdown) {
    breakdown.facultyAvoidHits += avoid;
    breakdown.facultyGaps += gaps;
  }
  return avoid * WEIGHTS.facultyAvoid + gaps * WEIGHTS.facultyGap;
}

export function emptyBreakdown() {
  return { studentGaps: 0, singleClassDays: 0, lateClasses: 0, dayImbalance: 0, facultyAvoidHits: 0, facultyGaps: 0 };
}

/** Full cost with a human-readable breakdown (used for reports, not in the hot loop). */
export function totalCost(state) {
  const breakdown = emptyBreakdown();
  let soft = 0;
  for (let s = 0; s < state.c.S; s++) soft += sectionCost(state, s, breakdown);
  for (let f = 0; f < state.c.F; f++) soft += facultyCost(state, f, breakdown);
  breakdown.dayImbalance = Math.round(breakdown.dayImbalance * 10) / 10;
  return { soft: Math.round(soft * 10) / 10, breakdown };
}
