import { useEffect, useState } from 'react';
import { download, errorMessage } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useFetch } from '../hooks.js';
import { TimetableGrid } from '../components/TimetableGrid.jsx';
import { ViewPicker } from '../components/ViewPicker.jsx';
import { Button, Empty, Notice, PageHeader, useToast } from '../components/ui.jsx';

/** The published timetable. Opens on the person's own section or teaching schedule. */
export function MyTimetable() {
  const { user } = useAuth();
  const { data: tt, error, loading } = useFetch('/timetables/published');
  const [view, setView] = useState({ type: 'section', id: null });
  const toast = useToast();

  useEffect(() => {
    if (!tt) return;
    if (user.facultyId && tt.problem.faculty.some((f) => f.id === user.facultyId)) setView({ type: 'faculty', id: user.facultyId });
    else if (user.sectionId && tt.problem.sections.some((s) => s.id === user.sectionId)) setView({ type: 'section', id: user.sectionId });
    else setView({ type: 'section', id: tt.problem.sections[0]?.id });
  }, [tt, user]);

  if (loading) return <p className="text-muted">Loading…</p>;
  if (error)
    return (
      <>
        <PageHeader title="My timetable" />
        {error.includes('not found') ? <Empty title="No timetable published yet">Your department hasn't published this semester's timetable. Check back soon.</Empty> : <Notice tone="error">{error}</Notice>}
      </>
    );
  if (!view.id) return null;
  const list = { section: tt.problem.sections, faculty: tt.problem.faculty, room: tt.problem.rooms }[view.type];
  const name = list.find((x) => x.id === view.id)?.name;
  const mine = (view.type === 'faculty' && view.id === user.facultyId) || (view.type === 'section' && view.id === user.sectionId);

  return (
    <>
      <PageHeader title={mine ? 'My timetable' : name} description={`${tt.name}, published ${new Date(tt.publishedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}`}>
        <Button variant="secondary" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
        <Button onClick={() => download(`/timetables/${tt.id}/ics?type=${view.type}&id=${view.id}`, `${name}.ics`).catch((e) => toast(errorMessage(e), 'error'))}>
          Add to my calendar
        </Button>
      </PageHeader>
      <div className="no-print mb-4">
        <ViewPicker problem={tt.problem} view={view} onChange={setView} />
      </div>
      <h2 className="mb-3 hidden text-xl font-bold print:block">{name}</h2>
      <TimetableGrid problem={tt.problem} events={tt.events} view={view} />
      <p className="no-print mt-3 text-sm text-muted">The calendar file works with Google Calendar, Outlook and Apple Calendar, and repeats every week of the term.</p>
    </>
  );
}
