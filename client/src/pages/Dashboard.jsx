import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorMessage, readEventStream } from '../api.js';
import { useFetch } from '../hooks.js';
import { Button, Empty, Field, Input, Notice, PageHeader, ProgressBar, Select, useToast } from '../components/ui.jsx';

const fmtDate = (d) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Dashboard() {
  const settings = useFetch('/settings');
  const pre = useFetch('/timetables/preflight');
  const versions = useFetch('/timetables?limit=50');
  const activity = useFetch('/audit?limit=8');
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [seconds, setSeconds] = useState('15');
  const [job, setJob] = useState(null); // { id, percent, message, status }
  const [error, setError] = useState(null);
  const [details, setDetails] = useState(null);
  const abort = useRef(null);
  useEffect(() => () => abort.current?.abort(), []);

  async function generate(e) {
    e.preventDefault();
    setError(null);
    setDetails(null);
    try {
      const { data } = await api.post('/timetables', { name: name.trim() || undefined, timeLimitSec: Number(seconds) });
      setJob({ id: data.id, name: data.name, percent: 0, message: 'Waiting for a worker…', status: 'queued' });
      abort.current = new AbortController();
      let final = null;
      await readEventStream(
        `/timetables/${data.id}/progress`,
        (_event, p) => {
          final = p;
          setJob((j) => ({ ...j, status: p.status, percent: p.progress?.percent ?? j.percent, message: p.progress?.message || j.message }));
        },
        abort.current.signal,
      );
      versions.reload();
      activity.reload();
      if (final?.status === 'done') {
        toast(final.unplaced ? `${data.name} is ready, but ${final.unplaced} classes could not be placed.` : `${data.name} is ready with zero clashes.`, final.unplaced ? 'warn' : 'ok');
        setName('');
      } else if (final?.status === 'failed') {
        setError(final.error || 'Generation failed');
        setDetails(final.validationErrors);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      setError(errorMessage(err));
      setDetails(err.response?.data?.details?.errors);
    }
  }

  async function remove(v) {
    if (!window.confirm(`Delete "${v.name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/timetables/${v.id}`);
      versions.reload();
      toast(`Deleted ${v.name}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  const s = pre.data?.summary;
  const running = job && (job.status === 'queued' || job.status === 'running');

  return (
    <>
      <PageHeader title="Overview" description={settings.data?.settings?.institution} />

      <section className="mb-8 grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="rounded-lg border border-line bg-sheet p-6">
          <h2 className="text-xl font-bold">Generate a timetable</h2>
          {s && (
            <p className="mt-1 text-muted">
              {s.classesPerWeek} classes a week for {s.sections} sections, taught by {s.faculty} teachers in {s.rooms} rooms, following {s.rules} availability rules.
            </p>
          )}
          {pre.data && !pre.data.ok && (
            <Notice tone="error" className="mt-4">
              <p className="font-bold">Fix these before generating:</p>
              <ul className="mt-1 list-inside list-disc">
                {pre.data.errors.slice(0, 8).map((e, i) => (
                  <li key={i}>{e.message}</li>
                ))}
              </ul>
              <Link className="mt-2 inline-block font-bold underline" to={pre.data.errors[0]?.code === 'CONFIG' ? '/settings' : '/data/faculty'}>
                Go to the data
              </Link>
            </Notice>
          )}
          <form onSubmit={generate} className="mt-5 grid gap-4 sm:grid-cols-[1fr_11rem_auto] sm:items-end">
            <Field label="Version name" hint="Optional">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`Version ${(versions.data?.total ?? 0) + 1}`} maxLength={120} />
            </Field>
            <Field label="Time to improve it">
              <Select value={seconds} onChange={(e) => setSeconds(e.target.value)}>
                <option value="5">5 seconds</option>
                <option value="15">15 seconds</option>
                <option value="30">30 seconds</option>
                <option value="60">1 minute</option>
              </Select>
            </Field>
            <Button type="submit" busy={running} disabled={pre.data && !pre.data.ok} className="py-2.5">
              Generate
            </Button>
          </form>
          {job && (
            <div className="mt-5">
              <ProgressBar value={job.percent} label={job.message} />
              {job.status === 'done' && (
                <Button variant="secondary" className="mt-3" onClick={() => navigate(`/timetables/${job.id}`)}>
                  Open {job.name}
                </Button>
              )}
            </div>
          )}
          {error && (
            <Notice tone="error" className="mt-4">
              <p className="font-bold">{error}</p>
              {details?.length > 0 && (
                <ul className="mt-1 list-inside list-disc">
                  {details.slice(0, 8).map((d, i) => (
                    <li key={i}>{d.message}</li>
                  ))}
                </ul>
              )}
            </Notice>
          )}
        </div>

        <div className="rounded-lg border border-line bg-sheet p-6">
          <h2 className="text-xl font-bold">Recent changes</h2>
          {activity.data?.items?.length ? (
            <ul className="mt-3 space-y-2.5 text-sm">
              {activity.data.items.map((a) => (
                <li key={a.id}>
                  <span className="font-bold">{a.actor?.name || 'System'}</span> {a.action.replace('-', ' ')}d {a.entity}
                  <span className="block text-xs text-muted">{fmtDate(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-muted">Nothing yet.</p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xl font-bold">Versions</h2>
        {versions.data?.items?.length ? (
          <div className="overflow-x-auto rounded-lg border border-line bg-sheet">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-bold">Name</th>
                  <th className="px-4 py-2.5 font-bold">Created</th>
                  <th className="px-4 py-2.5 font-bold">Result</th>
                  <th className="px-4 py-2.5 font-bold" title="Lower is better">Quality score</th>
                  <th className="px-4 py-2.5 font-bold">Edits</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {versions.data.items.map((v) => (
                  <tr key={v.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-3">
                      <Link to={`/timetables/${v.id}`} className="font-bold underline-offset-2 hover:underline">
                        {v.name}
                      </Link>
                      {v.published && <span className="ml-2 rounded bg-marigold-soft px-1.5 py-0.5 text-xs font-bold">Published</span>}
                    </td>
                    <td className="px-4 py-3 text-muted">{fmtDate(v.createdAt)}</td>
                    <td className="px-4 py-3">
                      {v.status === 'done' ? (
                        v.unplaced?.length ? <span className="text-clash">{v.unplaced.length} unplaced</span> : <span className="text-ok">No clashes</span>
                      ) : v.status === 'failed' ? (
                        <span className="text-clash">Failed</span>
                      ) : (
                        <span className="text-muted">{v.progress?.percent ?? 0}% done</span>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{v.score?.soft ?? '—'}</td>
                    <td className="px-4 py-3 tabular-nums">{v.editCount}</td>
                    <td className="px-4 py-3 text-right">
                      {!v.published && v.status !== 'running' && v.status !== 'queued' && (
                        <Button variant="quiet" onClick={() => remove(v)}>
                          Delete
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No timetables yet">Generate the first version above. You can make as many as you like and compare them.</Empty>
        )}
      </section>
    </>
  );
}
