import { api, errorMessage } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useFetch } from '../hooks.js';
import { PageHeader, Select, useToast } from '../components/ui.jsx';

const ROLES = [
  ['admin', 'Admin'],
  ['hod', 'Head of department'],
  ['faculty', 'Teacher'],
  ['student', 'Student'],
];

export function Users() {
  const { user: me } = useAuth();
  const users = useFetch('/users');
  const lookups = useFetch('/lookups');
  const toast = useToast();

  async function update(u, patch) {
    try {
      await api.patch(`/users/${u.id}`, patch);
      users.reload();
      toast(`Updated ${u.name}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  return (
    <>
      <PageHeader title="People & roles" description="New sign-ups are students. Link teachers and students to their timetable so it opens on their own week." />
      <div className="overflow-x-auto rounded-lg border border-line bg-sheet">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-muted">
            <tr>
              <th className="px-4 py-2.5 font-bold">Name</th>
              <th className="px-4 py-2.5 font-bold">Role</th>
              <th className="px-4 py-2.5 font-bold">Linked to</th>
            </tr>
          </thead>
          <tbody>
            {users.data?.items?.map((u) => (
              <tr key={u.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5">
                  <span className="font-bold">{u.name}</span>
                  <span className="block text-muted">{u.email}</span>
                </td>
                <td className="px-4 py-2.5">
                  <Select aria-label={`Role for ${u.name}`} value={u.role} disabled={u.id === me.id} onChange={(e) => update(u, { role: e.target.value })}>
                    {ROLES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="px-4 py-2.5">
                  {u.role === 'faculty' && (
                    <Select aria-label={`Teacher record for ${u.name}`} value={u.facultyId || ''} onChange={(e) => update(u, { facultyId: e.target.value || null })}>
                      <option value="">Not linked</option>
                      {lookups.data?.faculty.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </Select>
                  )}
                  {u.role === 'student' && (
                    <Select aria-label={`Section for ${u.name}`} value={u.sectionId || ''} onChange={(e) => update(u, { sectionId: e.target.value || null })}>
                      <option value="">Not linked</option>
                      {lookups.data?.sections.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
