import { VIEW_TYPES } from '../lib/timetable.js';
import { Field, Select } from './ui.jsx';

/** Choose whose timetable to look at: a section, a teacher or a room. */
export function ViewPicker({ problem, view, onChange }) {
  const listKey = VIEW_TYPES.find((v) => v.value === view.type).list;
  const options = [...problem[listKey]].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex gap-1 rounded-lg border border-line bg-sheet p-1" role="radiogroup" aria-label="Show timetable for">
        {VIEW_TYPES.map((t) => (
          <button
            key={t.value}
            role="radio"
            aria-checked={view.type === t.value}
            onClick={() => onChange({ type: t.value, id: [...problem[t.list]].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))[0]?.id })}
            className={`rounded-md px-3 py-1.5 text-sm font-bold ${view.type === t.value ? 'bg-marigold-soft text-ink' : 'text-ink-soft hover:text-ink'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Field label={VIEW_TYPES.find((v) => v.value === view.type).label} className="min-w-56">
        <select className="w-full rounded-md border border-line bg-sheet px-3 py-2 text-sm" value={view.id || ''} onChange={(e) => onChange({ ...view, id: e.target.value })}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}
