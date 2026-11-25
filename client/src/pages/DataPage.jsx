import { useRef, useState } from 'react';
import { NavLink, useParams } from 'react-router';
import { api, download, errorMessage } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useDebounced, useFetch } from '../hooks.js';
import { Button, ConfirmDrawer, Drawer, Empty, Field, Input, inputClass, Notice, PageHeader, Pager, ProgressBar, Select, useToast } from '../components/ui.jsx';

const TABS = [
  ['faculty', 'Teachers'],
  ['courses', 'Courses'],
  ['sections', 'Sections'],
  ['rooms', 'Rooms'],
  ['offerings', 'Who teaches what'],
  ['baskets', 'Elective baskets'],
];

const TYPE_LABEL = { rooms: { lecture: 'Lecture hall', lab: 'Lab' }, courses: { lecture: 'Lecture', lab: 'Lab' } };

const num = (v) => (v === '' || v == null ? undefined : Number(v));

// Column and form definitions for the four simple tables.
const ENTITIES = {
  faculty: {
    noun: 'teacher',
    sort: 'name',
    columns: [
      ['name', 'Name'],
      ['department', 'Stream'],
      ['maxPerDay', 'Max a day'],
      ['maxPerWeek', 'Max a week'],
      ['offeringCount', 'Classes assigned'],
    ],
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'department', label: 'Stream / department' },
      { key: 'maxPerDay', label: 'Most periods in a day', type: 'number', min: 1, max: 12, hint: 'Default 4' },
      { key: 'maxPerWeek', label: 'Most periods in a week', type: 'number', min: 1, max: 60, hint: 'Default 18' },
      { key: 'canTeach', label: 'Can also teach', type: 'courses', hint: 'Used to suggest substitutes' },
    ],
  },
  courses: {
    noun: 'course',
    sort: 'code',
    columns: [
      ['code', 'Code'],
      ['name', 'Name'],
      ['type', 'Type'],
      ['sessionsPerWeek', 'Sessions a week'],
      ['department', 'Stream'],
    ],
    fields: [
      { key: 'code', label: 'Course code', required: true },
      { key: 'name', label: 'Name', required: true },
      { key: 'type', label: 'Type', type: 'select', options: [['lecture', 'Lecture'], ['lab', 'Lab (double period)']], required: true },
      { key: 'sessionsPerWeek', label: 'Sessions a week', type: 'number', min: 1, max: 10, required: true },
      { key: 'department', label: 'Stream', hint: 'For example CSE-AIML' },
    ],
  },
  sections: {
    noun: 'section',
    sort: 'name',
    columns: [
      ['name', 'Name'],
      ['program', 'Stream'],
      ['semester', 'Semester'],
      ['size', 'Students'],
      ['homeRoomName', 'Home room'],
    ],
    fields: [
      { key: 'name', label: 'Name', required: true, hint: 'For example CSE 5-A' },
      { key: 'program', label: 'Stream', hint: 'For example CSE-AIML or CSE-AIFT' },
      { key: 'semester', label: 'Semester', type: 'number', min: 1, max: 12 },
      { key: 'size', label: 'Number of students', type: 'number', min: 1, required: true },
      { key: 'homeRoomId', label: 'Home room', type: 'room', hint: 'Tried first for this class, so students stay in one room' },
    ],
  },
  rooms: {
    noun: 'room',
    sort: 'name',
    columns: [
      ['name', 'Name'],
      ['type', 'Type'],
      ['capacity', 'Seats'],
      ['building', 'Building'],
    ],
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'type', label: 'Type', type: 'select', options: [['lecture', 'Lecture hall'], ['lab', 'Lab']], required: true },
      { key: 'capacity', label: 'Seats', type: 'number', min: 1, required: true },
      { key: 'building', label: 'Building' },
    ],
  },
};

export function DataPage() {
  const { tab } = useParams();
  return (
    <>
      <PageHeader title="Teachers & courses" description="Everything the timetable is built from. Changes apply to the next version you generate.">
        <DatasetFile />
      </PageHeader>
      <nav className="mb-6 flex flex-wrap gap-1 border-b border-line" aria-label="Data">
        {TABS.map(([k, label]) => (
          <NavLink key={k} to={`/data/${k}`} className={({ isActive }) => `-mb-px border-b-2 px-3 py-2 text-sm font-bold ${isActive ? 'border-marigold text-ink' : 'border-transparent text-ink-soft hover:text-ink'}`}>
            {label}
          </NavLink>
        ))}
      </nav>
      {ENTITIES[tab] && <EntityTable key={tab} entity={tab} def={ENTITIES[tab]} />}
      {tab === 'offerings' && <Offerings />}
      {tab === 'baskets' && <Baskets />}
    </>
  );
}

function EntityTable({ entity, def }) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ by: def.sort, order: 'asc' });
  const search = useDebounced(q);
  const list = useFetch(`/${entity}?q=${encodeURIComponent(search)}&page=${page}&limit=15&sort=${sort.by}&order=${sort.order}`);
  const [editing, setEditing] = useState(null); // {} for new, row for edit
  const toast = useToast();
  const sortable = new Set(['name', 'code', 'capacity', 'size', 'semester', 'type', 'department', 'building', 'maxPerWeek', 'sessionsPerWeek']);

  async function remove(row) {
    if (!window.confirm(`Delete ${row.name || row.code}?`)) return;
    try {
      await api.delete(`/${entity}/${row.id}`);
      toast(`Deleted ${row.name || row.code}`);
      list.reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="w-full max-w-xs">
          <Input type="search" placeholder={`Search ${def.noun}s`} aria-label={`Search ${def.noun}s`} value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} />
        </div>
        <div className="flex gap-2">
          <CsvImport entity={entity} onDone={list.reload} />
          <Button onClick={() => setEditing({})}>Add {def.noun}</Button>
        </div>
      </div>
      {list.error && <Notice tone="error">{list.error}</Notice>}
      {list.data?.items?.length === 0 ? (
        <Empty title={search ? `No ${def.noun}s match "${search}"` : `No ${def.noun}s yet`}>Add one, or import a spreadsheet saved as CSV.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-sheet">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-muted">
              <tr>
                {def.columns.map(([k, label]) => (
                  <th key={k} className="px-4 py-2.5 font-bold" aria-sort={sort.by === k ? (sort.order === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {sortable.has(k) ? (
                      <button className="font-bold hover:text-ink" onClick={() => setSort({ by: k, order: sort.by === k && sort.order === 'asc' ? 'desc' : 'asc' })}>
                        {label} {sort.by === k ? (sort.order === 'asc' ? '▲' : '▼') : ''}
                      </button>
                    ) : (
                      label
                    )}
                  </th>
                ))}
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {list.data?.items?.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-0">
                  {def.columns.map(([k]) => (
                    <td key={k} className={`px-4 py-2.5 ${k === 'name' || k === 'code' ? 'font-bold' : ''}`}>
                      {k === 'type' ? TYPE_LABEL[entity]?.[row[k]] || row[k] : (row[k] ?? '—')}
                    </td>
                  ))}
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    <Button variant="quiet" onClick={() => setEditing(row)}>
                      Edit
                    </Button>
                    <Button variant="quiet" onClick={() => remove(row)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={page} pages={list.data?.pages} onPage={setPage} />
      <EntityForm entity={entity} def={def} row={editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), list.reload())} />
    </>
  );
}

function EntityForm({ entity, def, row, onClose, onSaved }) {
  const isNew = row && !row.id;
  const [values, setValues] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const courses = useFetch('/lookups', { skip: !['faculty', 'sections'].includes(entity) || !row });
  const toast = useToast();
  // Reset the form whenever a different row is opened (React's "adjust state on prop change" pattern).
  const [lastRow, setLastRow] = useState(null);
  if (row !== lastRow) {
    setLastRow(row);
    if (row) {
      setValues(Object.fromEntries(def.fields.map((f) => [f.key, row[f.key] ?? (f.type === 'courses' ? [] : f.type === 'select' ? f.options[0][0] : '')])));
      setError(null);
    }
  }

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {};
    for (const f of def.fields) {
      const v = values[f.key];
      if (f.type === 'number') {
        if (num(v) !== undefined) body[f.key] = num(v);
        else if (!isNew && !f.required) body[f.key] = null;
      } else if (f.type === 'courses') body[f.key] = v;
      else if (v !== '' && v != null) body[f.key] = typeof v === 'string' ? v.trim() : v;
      else if (!isNew && !f.required) body[f.key] = null;
    }
    try {
      if (isNew) await api.post(`/${entity}`, body);
      else await api.patch(`/${entity}/${row.id}`, body);
      toast(isNew ? `Added ${body.name || body.code}` : 'Saved');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open={!!row} title={isNew ? `Add ${def.noun}` : `Edit ${row?.name || row?.code || ''}`} onClose={onClose}>
      <form className="space-y-4" onSubmit={save}>
        {def.fields.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            {f.type === 'select' ? (
              <Select value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                {f.options.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
            ) : f.type === 'room' ? (
              <Select value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                <option value="">No home room</option>
                {courses.data?.rooms?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.capacity} seats)
                  </option>
                ))}
              </Select>
            ) : f.type === 'courses' ? (
              <select
                multiple
                className={`${inputClass} h-40`}
                value={values[f.key] || []}
                onChange={(e) => setValues({ ...values, [f.key]: [...e.target.selectedOptions].map((o) => o.value) })}
              >
                {courses.data?.courses?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <Input type={f.type || 'text'} min={f.min} max={f.max} required={f.required} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            )}
          </Field>
        ))}
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" busy={busy} className="w-full">
          {isNew ? `Add ${def.noun}` : 'Save changes'}
        </Button>
      </form>
    </Drawer>
  );
}

/** Upload a CSV with a progress bar. Bad rows are listed by line number. */
// One JSON file holding everything on these tabs: settings, rooms, teachers, classes,
// subjects, who-teaches-what, elective baskets and availability rules.
function DatasetFile() {
  const { isAdmin, isEditor } = useAuth();
  const input = useRef(null);
  const [state, setState] = useState(null); // { busy } | { errors, message } | { done }
  const [builtIn, setBuiltIn] = useState(null); // dataset picked from the built-in list, waiting for confirmation
  const bundled = useFetch(isAdmin ? '/dataset/bundled' : null);
  const toast = useToast();
  if (!isEditor) return null;

  async function loadBuiltIn() {
    setState({ busy: true });
    try {
      const { data } = await api.post(`/dataset/bundled/${builtIn.id}`);
      const n = data.imported;
      setBuiltIn(null);
      setState(null);
      toast(`Loaded ${n.sections} classes, ${n.faculty} teachers and ${n.rooms} rooms`);
      window.setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      setBuiltIn(null);
      setState({ message: errorMessage(err), errors: err.response?.data?.details?.errors || [] });
    }
  }

  async function upload(file) {
    const ok = window.confirm(
      `Replace ALL teachers, rooms, classes, subjects and rules with the contents of "${file.name}"?\n\nLogins and saved timetable versions are kept. Download the current data first if you might want it back.`,
    );
    input.current.value = '';
    if (!ok) return;
    const form = new FormData();
    form.append('file', file);
    setState({ busy: true });
    try {
      const { data } = await api.post('/dataset', form);
      const n = data.imported;
      setState(null);
      toast(`Imported ${n.sections} classes, ${n.faculty} teachers, ${n.rooms} rooms and ${n.offerings + n.baskets} class assignments`);
      window.setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      setState({ message: errorMessage(err), errors: err.response?.data?.details?.errors || [] });
    }
  }

  return (
    <>
      <input ref={input} type="file" accept=".json,application/json" className="hidden" onChange={(e) => e.target.files[0] && upload(e.target.files[0])} />
      <Button variant="secondary" onClick={() => download('/dataset', 'slotwise-dataset.json').catch((err) => toast(errorMessage(err), 'error'))}>
        Download all data
      </Button>
      {isAdmin && (
        <Button variant="secondary" busy={state?.busy} onClick={() => input.current.click()}>
          {state?.busy ? 'Importing…' : 'Import full dataset'}
        </Button>
      )}
      {bundled.data?.items?.map((d) => (
        <Button key={d.id} variant="secondary" disabled={state?.busy} onClick={() => setBuiltIn(d)}>
          Load {d.id === 'chitkara-cse-ai' ? 'Chitkara CSE-AI data' : d.name}
        </Button>
      ))}
      <ConfirmDrawer open={!!builtIn} title="Replace all data?" confirmLabel="Replace and load" busy={state?.busy} onConfirm={loadBuiltIn} onClose={() => setBuiltIn(null)}>
        <p>
          This loads <span className="font-bold">{builtIn?.name}</span>: {builtIn?.sections} classes, {builtIn?.faculty} teachers and {builtIn?.rooms} rooms.
        </p>
        <p>All current teachers, rooms, classes, subjects and rules are replaced. Logins and saved timetable versions are kept.</p>
      </ConfirmDrawer>
      <Drawer open={!!state?.message} title="Nothing was imported" onClose={() => setState(null)}>
        <Notice tone="error">{state?.message}</Notice>
        <ul className="mt-4 space-y-2 text-sm">
          {state?.errors?.map((e, i) => (
            <li key={i}>{e.message}</li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-muted">Your current data has not been touched. Fix the file and import it again.</p>
      </Drawer>
    </>
  );
}

function CsvImport({ entity, onDone }) {
  const input = useRef(null);
  const [progress, setProgress] = useState(null);
  const [errors, setErrors] = useState(null);
  const toast = useToast();

  async function upload(file) {
    const form = new FormData();
    form.append('file', file);
    setErrors(null);
    setProgress(0);
    try {
      const { data } = await api.post(`/import/${entity}`, form, { onUploadProgress: (e) => setProgress(Math.round((e.loaded / (e.total || 1)) * 100)) });
      toast(`Imported ${data.imported} rows`);
      onDone();
    } catch (err) {
      setErrors({ message: errorMessage(err), rows: err.response?.data?.details?.rows || [] });
    } finally {
      setProgress(null);
      input.current.value = '';
    }
  }

  return (
    <>
      <input ref={input} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files[0] && upload(e.target.files[0])} />
      <Button variant="secondary" onClick={() => download(`/import/${entity}/template`, `${entity}-template.csv`)}>
        CSV template
      </Button>
      <Button variant="secondary" busy={progress !== null} onClick={() => input.current.click()}>
        Import CSV
      </Button>
      {progress !== null && (
        <div className="fixed inset-x-0 top-0 z-50 bg-sheet p-3 shadow">
          <ProgressBar value={progress} label={progress < 100 ? `Uploading… ${progress}%` : 'Checking every row…'} />
        </div>
      )}
      <Drawer open={!!errors} title="Nothing was imported" onClose={() => setErrors(null)}>
        <Notice tone="error">{errors?.message}</Notice>
        <ul className="mt-4 space-y-2 text-sm">
          {errors?.rows?.map((r) => (
            <li key={r.line}>
              <span className="font-bold">Line {r.line}:</span> {r.errors.join('; ')}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-muted">Fix these lines in your spreadsheet and import the file again. Rows that already exist are updated, not duplicated.</p>
      </Drawer>
    </>
  );
}

function Checkboxes({ items, value, onChange, label }) {
  return (
    <fieldset>
      <legend className="mb-1 text-sm font-bold">{label}</legend>
      <div className="grid max-h-48 grid-cols-2 gap-1 overflow-y-auto rounded-md border border-line p-2">
        {items.map((s) => (
          <label key={s.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={value.includes(s.id)} onChange={(e) => onChange(e.target.checked ? [...value, s.id] : value.filter((x) => x !== s.id))} />
            {s.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Offerings() {
  const [sectionId, setSectionId] = useState('');
  const [page, setPage] = useState(1);
  const list = useFetch(`/offerings?page=${page}&limit=20${sectionId ? `&sectionId=${sectionId}` : ''}`);
  const lookups = useFetch('/lookups');
  const [editing, setEditing] = useState(null);
  const toast = useToast();
  const L = lookups.data;

  async function save(e) {
    e.preventDefault();
    const body = {
      courseId: editing.courseId,
      facultyId: editing.facultyId,
      sectionIds: editing.sectionIds,
      size: num(editing.size) ?? null,
      duration: num(editing.duration) ?? null,
      sessionsPerWeek: num(editing.sessionsPerWeek) ?? null,
      maxSessionsPerDay: num(editing.maxSessionsPerDay) ?? null,
    };
    try {
      if (editing.id) await api.patch(`/offerings/${editing.id}`, body);
      else await api.post('/offerings', body);
      toast('Saved');
      setEditing(null);
      list.reload();
    } catch (err) {
      setEditing({ ...editing, error: errorMessage(err) });
    }
  }
  async function remove(o) {
    if (!window.confirm(`Remove ${o.courseCode} for ${o.sections.map((s) => s.name).join(', ')}?`)) return;
    await api.delete(`/offerings/${o.id}`).catch((err) => toast(errorMessage(err), 'error'));
    list.reload();
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <Field label="Section" className="w-56">
          <Select value={sectionId} onChange={(e) => (setSectionId(e.target.value), setPage(1))}>
            <option value="">All sections</option>
            {L?.sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex gap-2">
          <CsvImport entity="offerings" onDone={list.reload} />
          <Button disabled={!L} onClick={() => setEditing({ courseId: L.courses[0]?.id, facultyId: L.faculty[0]?.id, sectionIds: [], size: '', duration: '', sessionsPerWeek: '', maxSessionsPerDay: '' })}>
            Assign a class
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-lg border border-line bg-sheet">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-muted">
            <tr>
              <th className="px-4 py-2.5 font-bold">Course</th>
              <th className="px-4 py-2.5 font-bold">Teacher</th>
              <th className="px-4 py-2.5 font-bold">Sections</th>
              <th className="px-4 py-2.5 font-bold">Per week</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {list.data?.items?.map((o) => (
              <tr key={o.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5">
                  <span className="font-bold">{o.courseCode}</span> {o.courseName}
                </td>
                <td className="px-4 py-2.5">{o.facultyName}</td>
                <td className="px-4 py-2.5">{o.sections.map((s) => s.name).join(', ')}</td>
                <td className="px-4 py-2.5">
                  {o.sessionsPerWeek} {o.courseType === 'lab' ? 'lab' : 'lecture'}{o.sessionsPerWeek === 1 ? '' : 's'}
                  {o.duration > 1 && <span className="text-muted">, {o.duration} periods each</span>}
                  {o.maxSessionsPerDay > 1 && <span className="block text-xs text-muted">up to {o.maxSessionsPerDay} on one day</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right">
                  <Button variant="quiet" onClick={() =>
                      setEditing({
                        ...o,
                        sectionIds: o.sections.map((s) => s.id),
                        size: o.size ?? '',
                        duration: o.duration ?? '',
                        sessionsPerWeek: o.customSessionsPerWeek ?? '',
                        maxSessionsPerDay: o.maxSessionsPerDay ?? '',
                      })
                    }>
                    Edit
                  </Button>
                  <Button variant="quiet" onClick={() => remove(o)}>
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} pages={list.data?.pages} onPage={setPage} />
      <Drawer open={!!editing} title={editing?.id ? 'Edit class' : 'Assign a class'} onClose={() => setEditing(null)}>
        {editing && L && (
          <form className="space-y-4" onSubmit={save}>
            <Field label="Course">
              <Select value={editing.courseId} onChange={(e) => setEditing({ ...editing, courseId: e.target.value })}>
                {L.courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Teacher">
              <Select value={editing.facultyId} onChange={(e) => setEditing({ ...editing, facultyId: e.target.value })}>
                {L.faculty.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Checkboxes label="Sections (pick several for a combined class)" items={L.sections} value={editing.sectionIds} onChange={(v) => setEditing({ ...editing, sectionIds: v })} />
            <Field label="Students attending" hint="Leave empty to use the sections' total">
              <Input type="number" min={1} value={editing.size} onChange={(e) => setEditing({ ...editing, size: e.target.value })} />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Classes a week" hint="Empty: course default">
                <Input type="number" min={1} max={10} value={editing.sessionsPerWeek} onChange={(e) => setEditing({ ...editing, sessionsPerWeek: e.target.value })} />
              </Field>
              <Field label="Periods each" hint="Empty: 1, or lab length">
                <Input type="number" min={1} max={6} value={editing.duration} onChange={(e) => setEditing({ ...editing, duration: e.target.value })} />
              </Field>
              <Field label="Most in a day" hint="Empty: spread out">
                <Input type="number" min={1} max={6} value={editing.maxSessionsPerDay} onChange={(e) => setEditing({ ...editing, maxSessionsPerDay: e.target.value })} />
              </Field>
            </div>
            {editing.error && <Notice tone="error">{editing.error}</Notice>}
            <Button type="submit" className="w-full" disabled={!editing.sectionIds.length}>
              Save
            </Button>
          </form>
        )}
      </Drawer>
    </>
  );
}

function Baskets() {
  const list = useFetch('/baskets');
  const lookups = useFetch('/lookups');
  const [editing, setEditing] = useState(null);
  const toast = useToast();
  const L = lookups.data;

  async function save(e) {
    e.preventDefault();
    const body = {
      name: editing.name,
      sessionsPerWeek: Number(editing.sessionsPerWeek),
      duration: Number(editing.duration || 1),
      maxSessionsPerDay: num(editing.maxSessionsPerDay) ?? null,
      sectionIds: editing.sectionIds,
      options: editing.options.map((o) => ({ ...(o.offeringId ? { offeringId: o.offeringId } : {}), courseId: o.courseId, facultyId: o.facultyId, size: Number(o.size) })),
    };
    try {
      if (editing.id) await api.put(`/baskets/${editing.id}`, body);
      else await api.post('/baskets', body);
      toast('Saved');
      setEditing(null);
      list.reload();
    } catch (err) {
      setEditing({ ...editing, error: errorMessage(err) });
    }
  }
  const setOpt = (i, patch) => setEditing({ ...editing, options: editing.options.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  const blankOption = () => ({ courseId: L.courses[0]?.id, facultyId: L.faculty[0]?.id, size: 60 });

  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted">
          Under NEP 2020, students from several sections each pick one elective. All options in a basket run at the same time, so whichever one a student picks, it never clashes with their other classes.
        </p>
        <Button disabled={!L} onClick={() => setEditing({ name: '', sessionsPerWeek: 2, duration: 1, maxSessionsPerDay: '', sectionIds: [], options: [blankOption(), blankOption()] })}>
          Add basket
        </Button>
      </div>
      {list.data?.items?.length === 0 && <Empty title="No elective baskets">Add one if sections share open or programme electives.</Empty>}
      <div className="space-y-3">
        {list.data?.items?.map((b) => (
          <div key={b.id} className="rounded-lg border border-line bg-sheet p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-bold">{b.name}</p>
                <p className="text-sm text-muted">
                  {b.sessionsPerWeek} {b.sessionsPerWeek === 1 ? 'session' : 'sessions'} a week{b.duration > 1 ? `, ${b.duration} periods each,` : ''} for {b.sections.map((s) => s.name).join(', ')}
                </p>
              </div>
              <div>
                <Button variant="quiet" onClick={() => setEditing({ ...b, sectionIds: b.sections.map((s) => s.id), maxSessionsPerDay: b.maxSessionsPerDay ?? '' })}>
                  Edit
                </Button>
                <Button variant="quiet" onClick={async () => window.confirm(`Delete ${b.name}?`) && (await api.delete(`/baskets/${b.id}`), list.reload())}>
                  Delete
                </Button>
              </div>
            </div>
            <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
              {b.options.map((o) => (
                <li key={o.offeringId}>
                  <span className="font-bold">{o.courseName}</span> — {o.facultyName}, up to {o.size}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <Drawer open={!!editing} title={editing?.id ? 'Edit basket' : 'Add elective basket'} onClose={() => setEditing(null)}>
        {editing && L && (
          <form className="space-y-4" onSubmit={save}>
            <Field label="Name">
              <Input required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Open Elective — Group 1" />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Sessions a week">
                <Input type="number" min={1} max={10} value={editing.sessionsPerWeek} onChange={(e) => setEditing({ ...editing, sessionsPerWeek: e.target.value })} />
              </Field>
              <Field label="Periods each">
                <Input type="number" min={1} max={6} value={editing.duration} onChange={(e) => setEditing({ ...editing, duration: e.target.value })} />
              </Field>
              <Field label="Most in a day" hint="Empty: spread out">
                <Input type="number" min={1} max={6} value={editing.maxSessionsPerDay} onChange={(e) => setEditing({ ...editing, maxSessionsPerDay: e.target.value })} />
              </Field>
            </div>
            <Checkboxes label="Sections choosing from this basket" items={L.sections} value={editing.sectionIds} onChange={(v) => setEditing({ ...editing, sectionIds: v })} />
            <fieldset className="space-y-3">
              <legend className="text-sm font-bold">Options (each needs its own teacher)</legend>
              {editing.options.map((o, i) => (
                <div key={i} className="space-y-2 rounded-md border border-line p-3">
                  <Select aria-label={`Option ${i + 1} course`} value={o.courseId} onChange={(e) => setOpt(i, { courseId: e.target.value })}>
                    {L.courses.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                  <Select aria-label={`Option ${i + 1} teacher`} value={o.facultyId} onChange={(e) => setOpt(i, { facultyId: e.target.value })}>
                    {L.faculty.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </Select>
                  <div className="flex items-center gap-2">
                    <Input aria-label={`Option ${i + 1} seats`} type="number" min={1} value={o.size} onChange={(e) => setOpt(i, { size: e.target.value })} />
                    <span className="whitespace-nowrap text-sm text-muted">seats</span>
                    {editing.options.length > 2 && (
                      <Button variant="quiet" type="button" onClick={() => setEditing({ ...editing, options: editing.options.filter((_, j) => j !== i) })}>
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              <Button variant="secondary" type="button" onClick={() => setEditing({ ...editing, options: [...editing.options, blankOption()] })}>
                Add option
              </Button>
            </fieldset>
            {editing.error && <Notice tone="error">{editing.error}</Notice>}
            <Button type="submit" className="w-full" disabled={!editing.sectionIds.length}>
              Save basket
            </Button>
          </form>
        )}
      </Drawer>
    </>
  );
}
