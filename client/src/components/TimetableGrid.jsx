// The weekly grid. While a class is dragged, every cell shows whether dropping it there
// is fine (marigold), would clash (red hatching), or is impossible (dimmed) — computed in
// the browser with the same engine code the server uses to check the final move.
import { useMemo, useState } from 'react';
import { applyMove, clashBaseline } from '@slotwise/engine';
import { courseColor, eventsForView, indexProblem, periodLabel, spanLabel } from '../lib/timetable.js';

export function TimetableGrid({ problem, events, view, editable = false, onMove, onSelect, selectedId, highlight }) {
  const cfg = problem.config;
  const D = cfg.days.length;
  const P = cfg.periodsPerDay;
  const breaks = useMemo(() => new Set(cfg.breaks || []), [cfg.breaks]);
  const idx = useMemo(() => indexProblem(problem), [problem]);
  const visible = useMemo(() => eventsForView(events, view.type, view.id), [events, view.type, view.id]);
  const [drag, setDrag] = useState(null); // { id, cells: Map("d:t" → status) }
  const [over, setOver] = useState(null);

  function startDrag(e, ev) {
    e.dataTransfer.setData('text/plain', ev.id);
    e.dataTransfer.effectAllowed = 'move';
    const baseline = clashBaseline(problem, events);
    const cells = new Map();
    for (let d = 0; d < D; d++) {
      for (let t = 0; t < P; t++) {
        const key = `${d}:${t}`;
        if (d === ev.day && t === ev.start) {
          cells.set(key, { status: 'current' });
          continue;
        }
        let blocked = t + ev.duration > P;
        for (let p = t; p < t + ev.duration && !blocked; p++) if (breaks.has(p)) blocked = true;
        if (blocked) {
          cells.set(key, { status: 'blocked', reason: 'Does not fit here (break or end of day)' });
          continue;
        }
        const r = applyMove(problem, events, ev.id, { day: d, start: t }, baseline);
        cells.set(key, r.newClashes.length ? { status: 'clash', reason: r.newClashes.map((c) => c.message).join('\n'), count: r.newClashes.length } : { status: 'ok' });
      }
    }
    // Defer so the drag image is taken before the grid re-renders.
    requestAnimationFrame(() => setDrag({ id: ev.id, duration: ev.duration, cells }));
  }

  const endDrag = () => {
    setDrag(null);
    setOver(null);
  };

  function drop(e, d, t) {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    const cell = drag?.cells.get(`${d}:${t}`);
    endDrag();
    if (!id || !cell || cell.status === 'current' || cell.status === 'blocked') return;
    onMove?.(id, d, t, cell);
  }

  const cellClass = (d, t) => {
    if (breaks.has(t)) return 'hatch-break';
    const c = drag?.cells.get(`${d}:${t}`);
    if (!c) return 'bg-sheet';
    if (c.status === 'ok') return over === `${d}:${t}` ? 'bg-marigold/40' : 'bg-marigold-soft';
    if (c.status === 'clash') return 'hatch-clash';
    if (c.status === 'blocked') return 'bg-paper';
    return 'bg-sheet';
  };

  const describe = (ev) => {
    const parts = ev.parts;
    const course = idx.courses.get(parts[0]?.courseId);
    const sectionNames = ev.sectionIds.map((s) => idx.sections.get(s)?.name || s).join(', ');
    if (ev.kind === 'basket' && view.type === 'section')
      return { title: ev.basketName || 'Elective', sub: `${parts.length} options in parallel`, meta: parts.map((p) => idx.courses.get(p.courseId)?.name).join(' / ') };
    const room = idx.rooms.get(parts[0]?.roomId)?.name || 'No room';
    const teacher = idx.faculty.get(parts[0]?.facultyId)?.name || '';
    if (view.type === 'section') return { title: course?.name, code: course?.code, sub: teacher, meta: room };
    if (view.type === 'faculty') return { title: course?.name, code: course?.code, sub: sectionNames, meta: room };
    return { title: course?.name, code: course?.code, sub: sectionNames, meta: teacher };
  };

  const placed = visible.filter((e) => e.day != null);
  const unplaced = visible.filter((e) => e.day == null);

  return (
    <div>
      {!editable && <Agenda cfg={cfg} events={placed} describe={describe} />}
      <div className={`overflow-x-auto rounded-lg border border-line bg-sheet print:block print:overflow-visible ${editable ? '' : 'hidden sm:block'}`}>
        <div
          className="grid min-w-[760px]"
          style={{ gridTemplateColumns: `5.75rem repeat(${D}, minmax(8.5rem, 1fr))`, gridTemplateRows: `2.5rem repeat(${P}, minmax(4.25rem, auto))` }}
          role="grid"
          aria-label="Weekly timetable"
        >
          <div className="border-b border-line" style={{ gridRow: 1, gridColumn: 1 }} />
          {cfg.days.map((day, d) => (
            <div key={day} role="columnheader" className="flex items-center border-b border-l border-line px-3 font-display font-bold" style={{ gridRow: 1, gridColumn: d + 2 }}>
              {day}
            </div>
          ))}
          {Array.from({ length: P }, (_, t) => (
            <div key={`p${t}`} role="rowheader" className="border-b border-line px-2 py-2 text-xs leading-tight text-muted" style={{ gridRow: t + 2, gridColumn: 1 }}>
              <span className="block font-bold text-ink">{breaks.has(t) ? cfg.periodTimes?.[t]?.label || 'Break' : `P${t + 1 - [...breaks].filter((b) => b < t).length}`}</span>
              {periodLabel(cfg, t)}
            </div>
          ))}
          {Array.from({ length: D * P }, (_, i) => {
            const d = Math.floor(i / P);
            const t = i % P;
            const c = drag?.cells.get(`${d}:${t}`);
            return (
              <div
                key={`c${d}-${t}`}
                className={`border-b border-l border-line ${cellClass(d, t)}`}
                style={{ gridRow: t + 2, gridColumn: d + 2 }}
                title={c?.reason}
                onDragOver={(e) => {
                  if (!drag || !c || c.status === 'blocked' || c.status === 'current') return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (over !== `${d}:${t}`) setOver(`${d}:${t}`);
                }}
                onDragLeave={() => over === `${d}:${t}` && setOver(null)}
                onDrop={(e) => drop(e, d, t)}
              />
            );
          })}
          {placed.map((ev) => {
            const info = describe(ev);
            const color = ev.kind === 'basket' && view.type === 'section' ? { bg: '#eef0f6', bar: '#24306b' } : courseColor(ev.parts[0].courseId);
            const isDragged = drag?.id === ev.id;
            const isSel = selectedId === ev.id;
            const isHi = highlight?.has(ev.id);
            return (
              <button
                key={ev.id}
                type="button"
                draggable={editable}
                onDragStart={(e) => startDrag(e, ev)}
                onDragEnd={endDrag}
                onClick={() => onSelect?.(ev)}
                className={`relative m-1 flex flex-col overflow-hidden rounded-md border-l-4 px-2.5 py-1.5 text-left text-xs leading-snug ${editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'} ${isDragged ? 'opacity-40' : ''} ${isSel ? 'ring-2 ring-marigold' : ''} ${isHi ? 'outline-2 outline-dashed outline-marigold' : ''}`}
                style={{
                  gridRow: `${ev.start + 2} / span ${ev.duration}`,
                  gridColumn: ev.day + 2,
                  background: color.bg,
                  borderLeftColor: color.bar,
                  pointerEvents: drag && !isDragged ? 'none' : undefined,
                  zIndex: 1,
                }}
                aria-label={`${info.title}, ${problem.config.days[ev.day]} ${spanLabel(cfg, ev.start, ev.duration)}. ${info.sub}. ${info.meta}`}
              >
                <span className="font-bold text-ink">{info.title}</span>
                {(() => {
                  // Second line: the course code when it differs from the name, and the length of long classes.
                  const line = [info.code && info.code !== info.title ? info.code : null, ev.duration > 1 ? `${ev.duration} periods` : null].filter(Boolean).join(', ');
                  return line ? <span style={{ color: color.bar }}>{line}</span> : null;
                })()}
                <span className="mt-auto pt-1 text-ink-soft">{info.sub}</span>
                <span className="text-muted">{info.meta}</span>
              </button>
            );
          })}
        </div>
      </div>
      {drag && (
        <p className="no-print mt-2 text-sm text-muted" aria-live="polite">
          Drop on a marigold cell. Red cells would create a clash — hover one to see why.
        </p>
      )}
      {unplaced.length > 0 && (
        <div className="mt-4 rounded-md border border-clash/40 bg-clash-soft px-4 py-3 text-sm">
          <p className="font-bold text-clash">{unplaced.length} class(es) here could not be placed</p>
          <ul className="mt-1 list-inside list-disc">
            {unplaced.map((ev) => (
              <li key={ev.id}>{idx.courses.get(ev.parts[0]?.courseId)?.name || ev.basketName} — needs {ev.duration} period(s)</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Phones: one list per day instead of a wide grid (read-only views only). */
function Agenda({ cfg, events, describe }) {
  return (
    <div className="space-y-5 sm:hidden print:hidden">
      {cfg.days.map((day, d) => {
        const list = events.filter((e) => e.day === d).sort((a, b) => a.start - b.start);
        return (
          <section key={day}>
            <h3 className="mb-2 text-lg font-bold">{day}</h3>
            {list.length === 0 && <p className="text-sm text-muted">No classes</p>}
            <ol className="space-y-2">
              {list.map((ev) => {
                const info = describe(ev);
                const color = ev.kind === 'basket' ? { bg: '#eef0f6', bar: '#24306b' } : courseColor(ev.parts[0].courseId);
                const end = cfg.periodTimes?.[ev.start + ev.duration - 1]?.end;
                return (
                  <li key={ev.id} className="grid grid-cols-[4.5rem_1fr] gap-3 rounded-md border-l-4 px-3 py-2 text-sm" style={{ background: color.bg, borderLeftColor: color.bar }}>
                    <span className="tabular-nums text-ink-soft">
                      {cfg.periodTimes?.[ev.start]?.start || `P${ev.start + 1}`}
                      {end && <span className="block text-muted">{end}</span>}
                    </span>
                    <span>
                      <span className="block font-bold">{info.title}</span>
                      <span className="block text-ink-soft">{info.sub}</span>
                      <span className="block text-muted">{info.meta}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
