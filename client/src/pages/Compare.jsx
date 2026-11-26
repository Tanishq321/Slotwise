import { useEffect, useMemo, useState } from 'react';
import { useFetch } from '../hooks.js';
import { TimetableGrid } from '../components/TimetableGrid.jsx';
import { ViewPicker, firstOf } from '../components/ViewPicker.jsx';
import { Empty, Field, Notice, PageHeader, Select } from '../components/ui.jsx';
import { softLabels } from '../lib/timetable.js';

/** Two versions side by side. Classes that sit in a different slot are outlined. */
export function Compare() {
  const list = useFetch('/timetables?status=done&limit=100');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  useEffect(() => {
    const items = list.data?.items;
    if (items?.length >= 2 && !a) {
      setA(items[1].id);
      setB(items[0].id);
    }
  }, [list.data, a]);
  const summary = useFetch(a && b && a !== b ? `/timetables/compare?a=${a}&b=${b}` : null, { skip: !(a && b && a !== b) });
  const ta = useFetch(a ? `/timetables/${a}` : null, { skip: !a });
  const tb = useFetch(b ? `/timetables/${b}` : null, { skip: !b });
  const [view, setView] = useState({ type: 'section', id: null });
  useEffect(() => {
    if (ta.data && !view.id) setView({ type: 'section', id: firstOf(ta.data.problem) });
  }, [ta.data, view.id]);
  const moved = useMemo(() => new Set(summary.data?.movedEvents?.map((m) => m.id) || []), [summary.data]);

  const items = list.data?.items || [];
  if (list.data && items.length < 2)
    return (
      <>
        <PageHeader title="Compare versions" />
        <Empty title="You need two finished versions">Generate another version from the overview, for example with more time to improve it, then come back here.</Empty>
      </>
    );

  const pick = (value, set, label) => (
    <Field label={label} className="min-w-60">
      <Select value={value} onChange={(e) => set(e.target.value)}>
        {items.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
            {v.published ? ' (published)' : ''}
          </option>
        ))}
      </Select>
    </Field>
  );
  const s = summary.data;
  return (
    <>
      <PageHeader title="Compare versions" description="Classes outlined in marigold sit in a different slot in the other version." />
      <div className="mb-5 flex flex-wrap items-end gap-4">
        {pick(a, setA, 'Left')}
        {pick(b, setB, 'Right')}
        {ta.data && <ViewPicker problem={ta.data.problem} view={view} onChange={setView} />}
      </div>
      {a === b && <Notice tone="warn">Pick two different versions.</Notice>}
      {s && (
        <div className="mb-5 grid gap-4 rounded-lg border border-line bg-sheet p-5 text-sm md:grid-cols-3">
          <p>
            <span className="block font-display text-2xl font-bold tabular-nums">{s.moved}</span>
            classes in a different slot, {s.sameSlot} unchanged
          </p>
          {[s.a, s.b].map((v) => (
            <div key={v.id}>
              <p className="font-bold">
                {v.name}: quality score {v.score?.soft}
              </p>
              <ul className="text-muted">
                {Object.entries(v.score?.breakdown || {})
                  .filter(([, n]) => n)
                  .map(([k, n]) => (
                    <li key={k}>
                      {softLabels[k]}: {n}
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {ta.data && tb.data && view.id && (
        <div className="grid gap-6 2xl:grid-cols-2">
          {[ta.data, tb.data].map((t) => (
            <div key={t.id}>
              <h2 className="mb-2 text-lg font-bold">{t.name}</h2>
              <TimetableGrid problem={t.problem} events={t.events} view={view} highlight={moved} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
