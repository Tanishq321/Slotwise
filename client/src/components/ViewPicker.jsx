import { VIEW_TYPES } from '../lib/timetable.js';
import { Field, Select } from './ui.jsx';

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

// Long lists read better in groups: classes by stream and semester, rooms by building, teachers by stream.
const groupOf = {
  sections: (s) => [s.program, s.semester && `semester ${s.semester}`].filter(Boolean).join(', '),
  rooms: (r) => r.building || '',
  faculty: (f) => f.department || '',
};

function grouped(list, key) {
  const groups = new Map();
  for (const item of [...list].sort(byName)) {
    const g = groupOf[key](item) || 'Other';
    groups.set(g, [...(groups.get(g) || []), item]);
  }
  if (groups.size < 2) return [['', [...list].sort(byName)]];
  return [...groups].sort(([a], [b]) => (a === 'Other') - (b === 'Other') || a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * What to show when nothing is chosen yet: the class set in Settings as "shown first",
 * otherwise the first item of the first group.
 */
export function firstOf(problem, type = 'section') {
  const listKey = VIEW_TYPES.find((v) => v.value === type).list;
  if (type === 'section' && problem.sections.some((s) => s.id === problem.defaultSectionId)) return problem.defaultSectionId;
  return grouped(problem[listKey], listKey)[0]?.[1][0]?.id;
}

/** Choose whose timetable to look at: a section, a teacher or a room. */
export function ViewPicker({ problem, view, onChange }) {
  const listKey = VIEW_TYPES.find((v) => v.value === view.type).list;
  const groups = grouped(problem[listKey], listKey);
  const option = (o) => (
    <option key={o.id} value={o.id}>
      {o.name}
    </option>
  );
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex gap-1 rounded-lg border border-line bg-sheet p-1" role="radiogroup" aria-label="Show timetable for">
        {VIEW_TYPES.map((t) => (
          <button
            key={t.value}
            role="radio"
            aria-checked={view.type === t.value}
            onClick={() => t.value !== view.type && onChange({ type: t.value, id: firstOf(problem, t.value) })}
            className={`rounded-md px-3 py-1.5 text-sm font-bold ${view.type === t.value ? 'bg-marigold-soft text-ink' : 'text-ink-soft hover:text-ink'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Field label={VIEW_TYPES.find((v) => v.value === view.type).label} className="min-w-56">
        <select className="w-full rounded-md border border-line bg-sheet px-3 py-2 text-sm" value={view.id || ''} onChange={(e) => onChange({ ...view, id: e.target.value })}>
          {groups.map(([label, items]) =>
            label ? (
              <optgroup key={label} label={label}>
                {items.map(option)}
              </optgroup>
            ) : (
              items.map(option)
            ),
          )}
        </select>
      </Field>
    </div>
  );
}
