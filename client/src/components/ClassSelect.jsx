import { useFetch } from '../hooks.js';

/** All classes, grouped by stream and semester (e.g. "CSE-AIML, semester 3"). */
export function ClassSelect({ value, onChange, placeholder = 'Choose your class', ...props }) {
  const { data } = useFetch('/auth/classes');
  const groups = new Map();
  for (const c of data?.items || []) {
    const label = [c.program, c.semester && `semester ${c.semester}`].filter(Boolean).join(', ') || 'Other';
    groups.set(label, [...(groups.get(label) || []), c]);
  }
  return (
    <select className="w-full rounded-md border border-line bg-sheet px-3 py-2 text-sm" value={value} onChange={(e) => onChange(e.target.value)} {...props}>
      <option value="">{data ? placeholder : 'Loading classes…'}</option>
      {[...groups].map(([label, items]) => (
        <optgroup key={label} label={label}>
          {items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
