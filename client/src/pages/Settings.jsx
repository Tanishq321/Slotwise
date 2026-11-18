import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api.js';
import { useFetch } from '../hooks.js';
import { Button, Field, Input, Notice, PageHeader, useToast } from '../components/ui.jsx';

const ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function Settings() {
  const { data } = useFetch('/settings');
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!data) return;
    setS(
      data.settings || {
        institution: '',
        days: ALL_DAYS.slice(0, 5),
        periodsPerDay: 8,
        breaks: [4],
        labDuration: 2,
        periodTimes: [],
        termStart: '',
        termWeeks: 16,
      },
    );
  }, [data]);
  if (!s) return <p className="text-muted">Loading…</p>;

  const times = Array.from({ length: s.periodsPerDay }, (_, i) => s.periodTimes[i] || { start: '', end: '' });
  const setTime = (i, k, v) => setS({ ...s, periodTimes: times.map((t, j) => (j === i ? { ...t, [k]: v } : t)) });

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const periodTimes = times.every((t) => t.start && t.end) ? times.map((t, i) => ({ start: t.start, end: t.end, ...(s.breaks.includes(i) ? { label: t.label || 'Lunch' } : {}) })) : [];
    try {
      await api.put('/settings', { ...s, periodTimes, termStart: s.termStart || null, periodsPerDay: Number(s.periodsPerDay), termWeeks: Number(s.termWeeks), labDuration: Number(s.labDuration) });
      toast('Saved. New versions will use these days and periods.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Days & periods" description="The shape of the week every timetable is built on." />
      <form onSubmit={save} className="grid max-w-4xl gap-8 lg:grid-cols-2">
        <div className="space-y-5">
          <Field label="Institution or department name">
            <Input value={s.institution} onChange={(e) => setS({ ...s, institution: e.target.value })} required />
          </Field>
          <fieldset>
            <legend className="mb-1 text-sm font-bold">Teaching days</legend>
            <div className="flex flex-wrap gap-2">
              {ALL_DAYS.map((d) => (
                <label key={d} className="flex items-center gap-1.5 rounded-md border border-line bg-sheet px-3 py-1.5 text-sm">
                  <input type="checkbox" checked={s.days.includes(d)} onChange={(e) => setS({ ...s, days: e.target.checked ? ALL_DAYS.filter((x) => x === d || s.days.includes(x)) : s.days.filter((x) => x !== d) })} />
                  {d}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Periods a day">
              <Input type="number" min={1} max={16} value={s.periodsPerDay} onChange={(e) => setS({ ...s, periodsPerDay: Number(e.target.value) || 1, breaks: s.breaks.filter((b) => b < Number(e.target.value)) })} />
            </Field>
            <Field label="Lab length (periods)">
              <Input type="number" min={1} max={4} value={s.labDuration} onChange={(e) => setS({ ...s, labDuration: e.target.value })} />
            </Field>
            <Field label="Term starts" hint="Used for calendar files">
              <Input type="date" value={s.termStart || ''} onChange={(e) => setS({ ...s, termStart: e.target.value })} />
            </Field>
            <Field label="Weeks in term">
              <Input type="number" min={1} max={52} value={s.termWeeks} onChange={(e) => setS({ ...s, termWeeks: e.target.value })} />
            </Field>
          </div>
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-bold">Period times</legend>
          <p className="mb-3 text-sm text-muted">Tick the periods that are breaks. Times are needed for calendar export and rules like "before 10".</p>
          <div className="space-y-2">
            {times.map((t, i) => (
              <div key={i} className="grid grid-cols-[2.5rem_1fr_1fr_auto] items-center gap-2 text-sm">
                <span className="font-bold">{i + 1}</span>
                <Input type="time" aria-label={`Period ${i + 1} start`} value={t.start} onChange={(e) => setTime(i, 'start', e.target.value)} />
                <Input type="time" aria-label={`Period ${i + 1} end`} value={t.end} onChange={(e) => setTime(i, 'end', e.target.value)} />
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={s.breaks.includes(i)} onChange={(e) => setS({ ...s, breaks: e.target.checked ? [...s.breaks, i].sort((a, b) => a - b) : s.breaks.filter((b) => b !== i) })} />
                  Break
                </label>
              </div>
            ))}
          </div>
        </fieldset>
        <div className="lg:col-span-2">
          {error && <Notice tone="error" className="mb-3">{error}</Notice>}
          <Button type="submit" busy={busy}>
            Save
          </Button>
        </div>
      </form>
    </>
  );
}
