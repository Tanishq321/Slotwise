import { useEffect, useMemo, useReducer, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, download, errorMessage } from '../api.js';
import { useFetch, useMediaQuery } from '../hooks.js';
import { TimetableGrid } from '../components/TimetableGrid.jsx';
import { ViewPicker } from '../components/ViewPicker.jsx';
import { Button, ConfirmDrawer, Drawer, Field, Notice, PageHeader, Select, useToast } from '../components/ui.jsx';
import { indexProblem, periodLabel, softLabels, spanLabel } from '../lib/timetable.js';

// Local copy of the timetable, updated after each successful move.
function reducer(state, action) {
  switch (action.type) {
    case 'load':
      return action.tt;
    case 'moved':
      return { ...state, editCount: state.editCount + 1, score: action.score, events: state.events.map((e) => (e.id === action.event.id ? action.event : e)) };
    case 'published':
      return { ...state, published: true, publishedAt: action.at };
    default:
      return state;
  }
}

export function TimetablePage() {
  const { id } = useParams();
  const remote = useFetch(`/timetables/${id}`);
  const [tt, dispatch] = useReducer(reducer, null);
  const [view, setView] = useState({ type: 'section', id: null });
  const [tab, setTab] = useState('grid');
  const [selected, setSelected] = useState(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const wide = useMediaQuery('(min-width: 1280px)'); // the details panel sits beside the grid only on wide screens
  const toast = useToast();

  useEffect(() => {
    if (remote.data) {
      dispatch({ type: 'load', tt: remote.data });
      setView((v) => (v.id ? v : { type: 'section', id: remote.data.problem.sections[0]?.id }));
    }
  }, [remote.data]);

  if (remote.error) return <Notice tone="error">{remote.error}</Notice>;
  if (!tt) return <p className="text-muted">Loading timetable…</p>;
  if (tt.status !== 'done')
    return (
      <Notice tone={tt.status === 'failed' ? 'error' : 'info'}>
        {tt.status === 'failed' ? `This version failed: ${tt.error}` : 'This version is still being generated. Watch its progress on the overview.'}{' '}
        <Link to="/" className="font-bold underline">
          Back to overview
        </Link>
      </Notice>
    );

  async function move(eventId, day, start, preview, force = false) {
    if (preview?.status === 'clash' && !force) {
      toast(`That would clash: ${preview.reason.split('\n')[0]}`, 'error', { label: 'Move anyway', run: () => move(eventId, day, start, preview, true) });
      return;
    }
    try {
      const { data } = await api.patch(`/timetables/${tt.id}/events/${encodeURIComponent(eventId)}`, { day, start, force });
      dispatch({ type: 'moved', event: data.event, score: data.score });
      setSelected(data.event);
      toast(force && data.clashes.length ? 'Moved, with a clash. Fix it before publishing.' : `Moved to ${tt.problem.config.days[day]}, ${periodLabel(tt.problem.config, start)}`, force && data.clashes.length ? 'warn' : 'ok');
    } catch (err) {
      const clashes = err.response?.data?.details?.clashes;
      toast(clashes ? `That would clash: ${clashes[0].message}` : errorMessage(err), 'error', clashes ? { label: 'Move anyway', run: () => move(eventId, day, start, null, true) } : undefined);
    }
  }

  async function publish() {
    setConfirmPublish(false);
    try {
      const { data } = await api.post(`/timetables/${tt.id}/publish`);
      dispatch({ type: 'published', at: data.publishedAt });
      toast(`Published ${tt.name}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  const subjectName = (() => {
    const list = { section: tt.problem.sections, faculty: tt.problem.faculty, room: tt.problem.rooms }[view.type];
    return list.find((x) => x.id === view.id)?.name || '';
  })();

  return (
    <>
      <PageHeader title={tt.name} description={tt.published ? 'Published — this is what students and teachers see.' : 'Draft — only editors can see this version.'}>
        <Button variant="secondary" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
        <Button variant="secondary" onClick={() => download(`/timetables/${tt.id}/ics?type=${view.type}&id=${view.id}`, `${subjectName}.ics`).catch((e) => toast(errorMessage(e), 'error'))}>
          Download calendar
        </Button>
        {!tt.published && <Button onClick={() => setConfirmPublish(true)}>Publish</Button>}
      </PageHeader>

      <div className="no-print mb-5 flex flex-wrap items-end justify-between gap-4">
        <div className="flex gap-1 rounded-lg border border-line bg-sheet p-1" role="tablist">
          {[
            ['grid', 'Timetable'],
            ['substitutes', 'Teacher absent'],
            ['analytics', 'Workload & rooms'],
          ].map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1.5 text-sm font-bold ${tab === k ? 'bg-ink text-white' : 'text-ink-soft hover:text-ink'}`}>
              {label}
            </button>
          ))}
        </div>
        <Score score={tt.score} unplaced={tt.unplaced.length} edits={tt.editCount} />
      </div>

      {tab === 'grid' && (
        <div className="grid gap-6 xl:grid-cols-[1fr_18rem]">
          <div>
            <div className="no-print mb-4">
              <ViewPicker problem={tt.problem} view={view} onChange={(v) => (setView(v), setSelected(null))} />
            </div>
            <h2 className="mb-3 hidden text-xl font-bold print:block">
              {subjectName} — {tt.name}
            </h2>
            <TimetableGrid problem={tt.problem} events={tt.events} view={view} editable onMove={move} onSelect={setSelected} selectedId={selected?.id} />
            <p className="no-print mt-3 text-sm text-muted">Drag a class to move it, or select it to move it with the keyboard.</p>
          </div>
          {wide ? (
            <aside className="no-print">
              <EventPanel tt={tt} event={selected} onMove={move} />
            </aside>
          ) : (
            <Drawer open={!!selected} title="Class details" onClose={() => setSelected(null)}>
              <EventPanel tt={tt} event={selected} onMove={move} />
            </Drawer>
          )}
        </div>
      )}
      {tab === 'substitutes' && <Substitutes tt={tt} />}
      {tab === 'analytics' && <Analytics id={tt.id} />}
      <ConfirmDrawer open={confirmPublish} title={`Publish ${tt.name}?`} confirmLabel="Publish" onConfirm={publish} onClose={() => setConfirmPublish(false)}>
        <p>Students and teachers will see this timetable straight away. Any version published before it goes back to being a draft.</p>
      </ConfirmDrawer>
    </>
  );
}

function Score({ score, unplaced, edits }) {
  const parts = score?.breakdown ? Object.entries(score.breakdown).filter(([, v]) => v > 0) : [];
  return (
    <details className="relative text-sm">
      <summary className="cursor-pointer list-none rounded-md border border-line bg-sheet px-3 py-2">
        <span className={unplaced || score?.hardViolations ? 'font-bold text-clash' : 'font-bold text-ok'}>
          {unplaced ? `${unplaced} unplaced` : score?.hardViolations ? `${score.hardViolations} clash(es)` : 'No clashes'}
        </span>
        <span className="ml-3 text-muted">Quality score {score?.soft ?? '—'}</span>
        {edits > 0 && <span className="ml-3 text-muted">{edits} manual {edits === 1 ? 'edit' : 'edits'}</span>}
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-72 rounded-lg border border-line bg-sheet p-4 shadow-lg">
        <p className="font-bold">What the score counts</p>
        <p className="mb-2 text-muted">Lower is better. Clashes are never allowed; these are the nice-to-haves.</p>
        {parts.length ? (
          <dl className="space-y-1">
            {parts.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt>{softLabels[k] || k}</dt>
                <dd className="tabular-nums font-bold">{v}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p>Nothing to improve.</p>
        )}
      </div>
    </details>
  );
}

function EventPanel({ tt, event, onMove }) {
  const cfg = tt.problem.config;
  const idx = useMemo(() => indexProblem(tt.problem), [tt.problem]);
  const [day, setDay] = useState(0);
  const [start, setStart] = useState(0);
  useEffect(() => {
    if (event) {
      setDay(event.day ?? 0);
      setStart(event.start ?? 0);
    }
  }, [event]);

  if (!event)
    return (
      <div className="rounded-lg border border-dashed border-line p-5 text-sm text-muted">
        Select a class to see its details and move it to another slot.
      </div>
    );
  const breaks = new Set(cfg.breaks || []);
  return (
    <div className="rounded-lg border border-line bg-sheet p-5">
      <h3 className="text-lg font-bold">{event.basketName || idx.courses.get(event.parts[0].courseId)?.name}</h3>
      <p className="text-sm text-muted">
        {event.day != null ? `${cfg.days[event.day]}, ${spanLabel(cfg, event.start, event.duration)}` : 'Not placed'}, {event.duration} {event.duration === 1 ? 'period' : 'periods'}
      </p>
      <ul className="mt-3 space-y-2 text-sm">
        {event.parts.map((p) => (
          <li key={p.offeringId}>
            <span className="font-bold">{idx.courses.get(p.courseId)?.code}</span> {idx.faculty.get(p.facultyId)?.name}
            <span className="block text-muted">
              {idx.rooms.get(p.roomId)?.name || 'No room'}
              {p.size ? `, ${p.size} students` : ''}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-muted">Sections: {event.sectionIds.map((s) => idx.sections.get(s)?.name).join(', ')}</p>
      <form
        className="mt-4 space-y-3 border-t border-line pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          onMove(event.id, Number(day), Number(start));
        }}
      >
        <Field label="Day">
          <Select value={day} onChange={(e) => setDay(e.target.value)}>
            {cfg.days.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Starts at">
          <Select value={start} onChange={(e) => setStart(e.target.value)}>
            {Array.from({ length: cfg.periodsPerDay }, (_, p) => p)
              .filter((p) => !breaks.has(p))
              .map((p) => (
                <option key={p} value={p}>
                  {periodLabel(cfg, p)}
                </option>
              ))}
          </Select>
        </Field>
        <Button type="submit" className="w-full">
          Move class
        </Button>
      </form>
    </div>
  );
}

function Substitutes({ tt }) {
  const cfg = tt.problem.config;
  const [facultyId, setFacultyId] = useState(tt.problem.faculty[0]?.id);
  const [day, setDay] = useState(0);
  const result = useFetch(`/timetables/${tt.id}/substitutes?facultyId=${facultyId}&day=${day}`);
  const idx = useMemo(() => indexProblem(tt.problem), [tt.problem]);
  return (
    <div className="max-w-3xl">
      <p className="mb-4 text-muted">Pick who is absent and when. Slotwise lists colleagues who are free at that time and under their daily limit, qualified teachers first.</p>
      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        <Field label="Teacher who is absent">
          <Select value={facultyId} onChange={(e) => setFacultyId(e.target.value)}>
            {[...tt.problem.faculty].sort((a, b) => a.name.localeCompare(b.name)).map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Day">
          <Select value={day} onChange={(e) => setDay(e.target.value)}>
            {cfg.days.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {result.data?.items?.length === 0 && <Notice>No classes for this teacher on {cfg.days[day]}.</Notice>}
      <ol className="space-y-3">
        {result.data?.items?.map((c) => (
          <li key={c.eventId} className="rounded-lg border border-line bg-sheet p-4">
            <p className="font-bold">
              {spanLabel(cfg, c.start, c.duration)} — {c.courseName}
            </p>
            <p className="text-sm text-muted">
              {c.sectionIds.map((s) => idx.sections.get(s)?.name).join(', ')} in {idx.rooms.get(c.roomId)?.name}
            </p>
            {c.candidates.length ? (
              <ul className="mt-2 flex flex-wrap gap-2 text-sm">
                {c.candidates.map((k) => (
                  <li key={k.facultyId} className={`rounded-md border px-2.5 py-1 ${k.qualified ? 'border-ok/40 bg-ok-soft' : 'border-line'}`}>
                    {k.name}
                    <span className="text-muted"> — {k.qualified ? 'teaches this course' : `${k.periodsToday} periods that day`}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-clash">Nobody is free then. Consider moving the class.</p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Analytics({ id }) {
  const { data, error } = useFetch(`/timetables/${id}/analytics`);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <p className="text-muted">Loading…</p>;
  const maxDay = Math.max(...data.days.map((d) => d.periods), 1);
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section>
        <h2 className="mb-1 text-xl font-bold">Teaching load</h2>
        <p className="mb-3 text-sm text-muted">Periods per week, against each teacher's weekly limit.</p>
        <ul className="space-y-2">
          {data.faculty.map((f) => (
            <li key={f.id} className="grid grid-cols-[11rem_1fr_3rem] items-center gap-3 text-sm">
              <span className="truncate">{f.name}</span>
              <span className="h-2.5 rounded-full bg-line">
                <span className="block h-full rounded-full bg-ink" style={{ width: `${Math.min(100, (f.periods / (f.maxPerWeek || 30)) * 100)}%` }} />
              </span>
              <span className="text-right tabular-nums">
                {f.periods}/{f.maxPerWeek ?? '—'}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="mb-1 text-xl font-bold">Room use</h2>
        <p className="mb-3 text-sm text-muted">Share of the {data.weekSlots} teaching periods each room is booked.</p>
        <ul className="space-y-2">
          {data.rooms.map((r) => (
            <li key={r.id} className="grid grid-cols-[11rem_1fr_3rem] items-center gap-3 text-sm">
              <span className="truncate">
                {r.name} <span className="text-muted">({r.type === 'lab' ? 'lab' : r.capacity})</span>
              </span>
              <span className="h-2.5 rounded-full bg-line">
                <span className={`block h-full rounded-full ${r.utilisation > 90 ? 'bg-marigold' : 'bg-ink-soft'}`} style={{ width: `${r.utilisation}%` }} />
              </span>
              <span className="text-right tabular-nums">{r.utilisation}%</span>
            </li>
          ))}
        </ul>
        <h2 className="mb-1 mt-8 text-xl font-bold">Classes per day</h2>
        <div className="mt-3 flex h-36 items-end gap-3">
          {data.days.map((d) => (
            <div key={d.day} className="flex flex-1 flex-col items-center gap-1 text-sm">
              <span className="tabular-nums text-muted">{d.classes}</span>
              <span className="w-full rounded-t-md bg-ink" style={{ height: `${(d.periods / maxDay) * 100}px` }} />
              <span className="font-bold">{d.name}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
