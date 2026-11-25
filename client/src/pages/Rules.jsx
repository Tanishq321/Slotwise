import { useState } from 'react';
import { api, errorMessage } from '../api.js';
import { useFetch } from '../hooks.js';
import { Button, Empty, Field, Input, inputClass, Notice, PageHeader, Select, useToast } from '../components/ui.jsx';
import { periodLabel } from '../lib/timetable.js';

// Example sentences use real names from the current data, so they work when clicked.
const examples = (L) => {
  const [a, b] = [L?.faculty?.[0]?.name || 'Dr. Sharma', L?.faculty?.[1]?.name || 'Dr. Malhotra'];
  const sec = L?.sections?.[0]?.name || 'CSE 5-B';
  return [`${a} can't teach before 10 on Mondays`, `${b} prefers not to teach the first period`, `${sec} is unavailable on Friday afternoon`];
};

// The same rule on several days (e.g. lunch every day) is shown as one row.
function groupRules(items = []) {
  const groups = new Map();
  for (const r of items) {
    const k = [r.subjectType, r.subjectId, r.kind, r.periodFrom, r.periodTo, r.sourceText || r.note || ''].join('|');
    const g = groups.get(k) || { ...r, ids: [], days: [] };
    g.ids.push(r.id);
    g.days.push(r.day);
    groups.set(k, g);
  }
  return [...groups.values()];
}

function dayList(days, names) {
  const d = [...new Set(days)].sort((a, b) => a - b);
  const run = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  if (d.length > 2 && run) return `${names[d[0]]}–${names[d[d.length - 1]]}`;
  return d.map((x) => names[x]).join(', ');
}

export function Rules() {
  const settings = useFetch('/settings');
  const rules = useFetch('/constraints');
  const lookups = useFetch('/lookups');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const toast = useToast();
  const cfg = settings.data?.settings;
  const EXAMPLES = examples(lookups.data);

  async function understand(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const { data } = await api.post('/constraints/parse', { text });
      setPreview(data);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function save(constraints, sourceText) {
    try {
      await api.post('/constraints', { constraints, sourceText });
      toast(`Saved ${constraints.length} rule(s). They apply to the next version you generate.`);
      setPreview(null);
      setText('');
      rules.reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function remove(g) {
    try {
      for (const id of g.ids) await api.delete(`/constraints/${id}`);
      toast(g.ids.length > 1 ? `Deleted the rule for ${g.ids.length} days` : 'Rule deleted');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
    rules.reload();
  }

  const describe = (r) =>
    `${cfg ? dayList(r.days, cfg.days) : r.days.join(', ')}, ${cfg ? periodLabel(cfg, r.periodFrom).split('–')[0] : r.periodFrom}–${cfg ? periodLabel(cfg, r.periodTo).split('–')[1] || '' : r.periodTo}`;

  return (
    <>
      <PageHeader title="Availability rules" description="When teachers or sections can't have classes. Hard rules are never broken; preferences are followed when possible." />
      <section className="mb-8 max-w-3xl rounded-lg border border-line bg-sheet p-6">
        <h2 className="text-xl font-bold">Describe a rule in your own words</h2>
        <form className="mt-4" onSubmit={understand}>
          <textarea className={`${inputClass} min-h-20`} value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLES[0]} maxLength={500} required aria-label="Rule" />
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">Try:</span>
            {EXAMPLES.slice(1).map((ex) => (
              <button key={ex} type="button" className="rounded border border-line px-2 py-0.5 text-ink-soft hover:border-ink-soft" onClick={() => setText(ex)}>
                {ex}
              </button>
            ))}
          </div>
          <Button type="submit" busy={busy} className="mt-4">
            Check what this means
          </Button>
        </form>
        {error && <Notice tone="error" className="mt-4">{error}</Notice>}
        {preview && (
          <div className="mt-5 border-t border-line pt-5">
            <p className="text-sm text-muted">{preview.source === 'ai' ? 'Understood with AI (Groq).' : 'Understood with the built-in parser.'} Nothing is saved until you confirm.</p>
            {preview.warnings.map((w) => (
              <Notice key={w} tone="warn" className="mt-2">
                {w}
              </Notice>
            ))}
            {preview.constraints.length ? (
              <>
                <ul className="mt-3 list-inside list-disc text-sm">
                  {preview.constraints.map((c, i) => (
                    <li key={i}>{c.summary}</li>
                  ))}
                </ul>
                <div className="mt-4 flex gap-2">
                  <Button onClick={() => save(preview.constraints.map(({ subjectType, subjectId, kind, day, periodFrom, periodTo }) => ({ subjectType, subjectId, kind, day, periodFrom, periodTo })), text)}>
                    Save {preview.constraints.length} rule(s)
                  </Button>
                  <Button variant="secondary" onClick={() => setPreview(null)}>
                    Discard
                  </Button>
                </div>
              </>
            ) : (
              <Notice tone="warn" className="mt-3">
                No rule was found. Name the teacher or section and the time, or add it by hand below.
              </Notice>
            )}
          </div>
        )}
      </section>

      {cfg && lookups.data && <ManualRule cfg={cfg} lookups={lookups.data} onSave={(list) => save(list)} />}

      <h2 className="mb-3 mt-8 text-xl font-bold">Saved rules</h2>
      {rules.data?.items?.length ? (
        <div className="overflow-x-auto rounded-lg border border-line bg-sheet">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-4 py-2.5 font-bold">Who</th>
                <th className="px-4 py-2.5 font-bold">When</th>
                <th className="px-4 py-2.5 font-bold">Kind</th>
                <th className="px-4 py-2.5 font-bold">Written as</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {groupRules(rules.data.items).map((r) => (
                <tr key={r.ids.join('-')} className="border-b border-line last:border-0">
                  <td className="px-4 py-2.5 font-bold">{r.subjectName}</td>
                  <td className="px-4 py-2.5">{describe(r)}</td>
                  <td className="px-4 py-2.5">{r.kind === 'avoid' ? 'Preference' : 'Never'}</td>
                  <td className="px-4 py-2.5 text-muted">{r.sourceText || r.note || '—'}</td>
                  <td className="px-4 py-2.5 text-right">
                    <Button variant="quiet" onClick={() => remove(r)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No rules yet">Without rules, every teacher and section is treated as available all day.</Empty>
      )}
    </>
  );
}

function ManualRule({ cfg, lookups, onSave }) {
  const teaching = Array.from({ length: cfg.periodsPerDay }, (_, p) => p).filter((p) => !cfg.breaks.includes(p));
  const [r, setR] = useState({ who: `faculty:${lookups.faculty[0]?.id}`, kind: 'unavailable', day: 0, periodFrom: teaching[0], periodTo: teaching[0] });
  const [subjectType, subjectId] = r.who.split(':');
  return (
    <details className="max-w-3xl rounded-lg border border-line bg-sheet p-5">
      <summary className="cursor-pointer font-bold">Add a rule by hand</summary>
      <form
        className="mt-4 grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          const days = r.day === 'all' ? cfg.days.map((_, i) => i) : [Number(r.day)];
          const kind = subjectType === 'section' ? 'unavailable' : r.kind;
          const periodTo = Math.max(Number(r.periodFrom), Number(r.periodTo));
          onSave(days.map((day) => ({ subjectType, subjectId, kind, day, periodFrom: Number(r.periodFrom), periodTo })));
        }}
      >
        <Field label="Teacher or section">
          <Select value={r.who} onChange={(e) => setR({ ...r, who: e.target.value, ...(e.target.value.startsWith('section:') ? { kind: 'unavailable' } : {}) })}>
            <optgroup label="Teachers">
              {lookups.faculty.map((f) => (
                <option key={f.id} value={`faculty:${f.id}`}>
                  {f.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Sections">
              {lookups.sections.map((s) => (
                <option key={s.id} value={`section:${s.id}`}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          </Select>
        </Field>
        <Field label="Kind" hint={subjectType === 'section' ? 'A class can only be blocked (for example lunch or sports). "Avoid if possible" is for teachers.' : undefined}>
          <Select value={subjectType === 'section' ? 'unavailable' : r.kind} onChange={(e) => setR({ ...r, kind: e.target.value })} disabled={subjectType === 'section'}>
            <option value="unavailable">Never schedule then</option>
            <option value="avoid">Avoid if possible</option>
          </Select>
        </Field>
        <Field label="Day">
          <Select value={r.day} onChange={(e) => setR({ ...r, day: e.target.value })}>
            <option value="all">Every day ({cfg.days[0]}–{cfg.days[cfg.days.length - 1]})</option>
            {cfg.days.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="From">
            <Select value={r.periodFrom} onChange={(e) => setR({ ...r, periodFrom: e.target.value })}>
              {teaching.map((p) => (
                <option key={p} value={p}>
                  {periodLabel(cfg, p).split('–')[0]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Until">
            <Select value={r.periodTo} onChange={(e) => setR({ ...r, periodTo: e.target.value })}>
              {teaching.map((p) => (
                <option key={p} value={p}>
                  {periodLabel(cfg, p).split('–')[1] || `P${p + 1}`}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Button type="submit" className="sm:col-span-2 sm:justify-self-start">
          Save rule
        </Button>
      </form>
    </details>
  );
}
