// Holds a (possibly partial) timetable and answers "can this class go here?" quickly.
// Every grid cell (section/teacher/room × day × period) stores the index of the event
// occupying it, or -1 when free. The solver only ever keeps hard-feasible states.

export class State {
  constructor(c) {
    this.c = c;
    const { D, P, S, F, R, events, keys } = c;
    this.secOcc = new Int32Array(S * D * P).fill(-1);
    this.facOcc = new Int32Array(F * D * P).fill(-1);
    this.roomOcc = new Int32Array(R * D * P).fill(-1);
    this.facDayLoad = new Int16Array(F * D);
    this.keyDayCount = new Int16Array(keys.length * D);
    this.day = new Int16Array(events.length).fill(-1);
    this.start = new Int16Array(events.length).fill(-1);
    this.rooms = new Array(events.length).fill(null);
    this.placedCount = 0;
  }

  cell(entity, d, p) {
    return (entity * this.c.D + d) * this.c.P + p;
  }

  isPlaced(e) {
    return this.day[e] >= 0;
  }

  /** Fixed rules that no amount of rearranging can fix (breaks, availability, day length). */
  structuralOk(ev, d, t) {
    const { P, isBreak, facUnavail, secUnavail } = this.c;
    if (t < 0 || t + ev.duration > P) return false;
    for (let p = t; p < t + ev.duration; p++) {
      if (isBreak[p]) return false;
      for (const s of ev.groups) if (secUnavail[this.cell(s, d, p)]) return false;
      for (const f of ev.facs) if (facUnavail[this.cell(f, d, p)]) return false;
    }
    return true;
  }

  /** All (day, start) pairs that pass the structural rules for this event. */
  positions(ev) {
    if (ev._positions) return ev._positions;
    const out = [];
    for (let d = 0; d < this.c.D; d++) for (let t = 0; t < this.c.P; t++) if (this.structuralOk(ev, d, t)) out.push([d, t]);
    ev._positions = out;
    return out;
  }

  /** Returns room assignment (one room per part) if the event fits, else null. */
  canPlace(e, d, t) {
    const c = this.c;
    const ev = c.events[e];
    if (!this.structuralOk(ev, d, t)) return null;
    if (this.keyDayCount[ev.keyIdx * c.D + d] >= c.keys[ev.keyIdx].limit) return null;
    for (const f of ev.facs) {
      let need = 0;
      for (const part of ev.parts) if (part.facIdx === f) need += ev.duration;
      if (this.facDayLoad[f * c.D + d] + need > c.maxPerDay[f]) return null;
    }
    for (let p = t; p < t + ev.duration; p++) {
      for (const s of ev.groups) if (this.secOcc[this.cell(s, d, p)] >= 0) return null;
      for (const f of ev.facs) if (this.facOcc[this.cell(f, d, p)] >= 0) return null;
    }
    return this.pickRooms(ev, d, t, null);
  }

  /** Choose a free room for each part (largest groups first). `ignore` = events treated as already removed. */
  pickRooms(ev, d, t, ignore) {
    const order = ev.parts.map((_, i) => i).sort((a, b) => ev.parts[b].size - ev.parts[a].size);
    const chosen = new Array(ev.parts.length);
    const used = new Set();
    for (const i of order) {
      let found = -1;
      for (const r of ev.parts[i].candidates) {
        if (used.has(r)) continue;
        let free = true;
        for (let p = t; p < t + ev.duration && free; p++) {
          const o = this.roomOcc[this.cell(r, d, p)];
          if (o >= 0 && !(ignore && ignore.has(o))) free = false;
        }
        if (free) {
          found = r;
          break;
        }
      }
      if (found < 0) return null;
      chosen[i] = found;
      used.add(found);
    }
    return chosen;
  }

  place(e, d, t, rooms) {
    const c = this.c;
    const ev = c.events[e];
    for (let p = t; p < t + ev.duration; p++) {
      for (const s of ev.groups) this.secOcc[this.cell(s, d, p)] = e;
      for (const f of ev.facs) this.facOcc[this.cell(f, d, p)] = e;
      for (const r of rooms) this.roomOcc[this.cell(r, d, p)] = e;
    }
    for (const part of ev.parts) this.facDayLoad[part.facIdx * c.D + d] += ev.duration;
    this.keyDayCount[ev.keyIdx * c.D + d]++;
    this.day[e] = d;
    this.start[e] = t;
    this.rooms[e] = rooms;
    this.placedCount++;
  }

  unplace(e) {
    const c = this.c;
    const ev = c.events[e];
    const d = this.day[e];
    const t = this.start[e];
    if (d < 0) return;
    for (let p = t; p < t + ev.duration; p++) {
      for (const s of ev.groups) this.secOcc[this.cell(s, d, p)] = -1;
      for (const f of ev.facs) this.facOcc[this.cell(f, d, p)] = -1;
      for (const r of this.rooms[e]) this.roomOcc[this.cell(r, d, p)] = -1;
    }
    for (const part of ev.parts) this.facDayLoad[part.facIdx * c.D + d] -= ev.duration;
    this.keyDayCount[ev.keyIdx * c.D + d]--;
    this.day[e] = -1;
    this.start[e] = -1;
    this.rooms[e] = null;
    this.placedCount--;
  }

  /**
   * Which placed events would have to be removed so `e` fits at (d, t)?
   * Returns null if the slot is structurally impossible for `e`.
   */
  conflictsFor(e, d, t) {
    const c = this.c;
    const ev = c.events[e];
    if (!this.structuralOk(ev, d, t)) return null;
    const set = new Set();
    for (let p = t; p < t + ev.duration; p++) {
      for (const s of ev.groups) {
        const o = this.secOcc[this.cell(s, d, p)];
        if (o >= 0) set.add(o);
      }
      for (const f of ev.facs) {
        const o = this.facOcc[this.cell(f, d, p)];
        if (o >= 0) set.add(o);
      }
    }
    // Same course twice on one day.
    const key = c.keys[ev.keyIdx];
    let count = 0;
    for (const x of key.events) if (x !== e && this.day[x] === d && !set.has(x)) count++;
    if (count >= key.limit) {
      for (const x of key.events) {
        if (count < key.limit) break;
        if (x !== e && this.day[x] === d && !set.has(x)) {
          set.add(x);
          count--;
        }
      }
    }
    // Teacher's daily limit.
    for (const f of ev.facs) {
      let need = 0;
      for (const part of ev.parts) if (part.facIdx === f) need += ev.duration;
      let load = this.facDayLoad[f * c.D + d];
      for (const x of set) if (this.day[x] === d) for (const part of c.events[x].parts) if (part.facIdx === f) load -= c.events[x].duration;
      if (load + need > c.maxPerDay[f]) {
        for (const x of c.facEvents[f]) {
          if (load + need <= c.maxPerDay[f]) break;
          if (x !== e && this.day[x] === d && !set.has(x)) {
            set.add(x);
            for (const part of c.events[x].parts) if (part.facIdx === f) load -= c.events[x].duration;
          }
        }
      }
    }
    // Rooms: if no free room, evict whoever holds the cheapest suitable room.
    if (!this.pickRooms(ev, d, t, set)) {
      const used = new Set();
      const order = ev.parts.map((_, i) => i).sort((a, b) => ev.parts[b].size - ev.parts[a].size);
      for (const i of order) {
        let best = -1;
        let bestCost = Infinity;
        let bestOcc = null;
        for (const r of ev.parts[i].candidates) {
          if (used.has(r)) continue;
          const occ = new Set();
          for (let p = t; p < t + ev.duration; p++) {
            const o = this.roomOcc[this.cell(r, d, p)];
            if (o >= 0 && !set.has(o)) occ.add(o);
          }
          if (occ.size < bestCost) {
            bestCost = occ.size;
            best = r;
            bestOcc = occ;
            if (bestCost === 0) break;
          }
        }
        if (best < 0) return null; // not enough rooms of this type exist at all
        used.add(best);
        for (const o of bestOcc) set.add(o);
      }
    }
    set.delete(e);
    return set;
  }

  snapshot() {
    return { day: this.day.slice(), start: this.start.slice(), rooms: this.rooms.slice() };
  }

  restore(snap) {
    for (let e = 0; e < this.c.events.length; e++) if (this.day[e] >= 0) this.unplace(e);
    for (let e = 0; e < this.c.events.length; e++) if (snap.day[e] >= 0) this.place(e, snap.day[e], snap.start[e], snap.rooms[e]);
  }
}
