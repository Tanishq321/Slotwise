import { useEffect, useState } from 'react';
import { download, errorMessage } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useFetch } from '../hooks.js';
import { TimetableGrid } from '../components/TimetableGrid.jsx';
import { ViewPicker } from '../components/ViewPicker.jsx';
import { Button, Empty, Field, Notice, PageHeader, useToast } from '../components/ui.jsx';
import { ClassSelect } from '../components/ClassSelect.jsx';

/** The published timetable. Opens on the person's own section or teaching schedule. */
export function MyTimetable() {
  const { user } = useAuth();
  const student = user.role === 'student';
  const needsClass = student && !user.sectionId;
  const { data: tt, error, loading, reload } = useFetch('/timetables/published', { skip: needsClass });
  const [view, setView] = useState({ type: 'section', id: null });
  const toast = useToast();

  useEffect(() => {
    if (!tt) return;
    if (tt.scope) setView(tt.scope); // students: the server only sends their own class
    else if (user.facultyId && tt.problem.faculty.some((f) => f.id === user.facultyId)) setView({ type: 'faculty', id: user.facultyId });
    else if (user.sectionId && tt.problem.sections.some((s) => s.id === user.sectionId)) setView({ type: 'section', id: user.sectionId });
    else setView({ type: 'section', id: tt.problem.sections[0]?.id });
  }, [tt, user]);

  if (needsClass || error?.startsWith('Choose your class') || error?.includes('Choose your class again')) return <ChooseClass message={error} onDone={reload} />;
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
  const mine = student || (view.type === 'faculty' && view.id === user.facultyId) || (view.type === 'section' && view.id === user.sectionId);

  return (
    <>
      <PageHeader title={student ? `${name} timetable` : mine ? 'My timetable' : name} description={`${tt.name}, published ${new Date(tt.publishedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}`}>
        <Button variant="secondary" onClick={() => window.print()}>
          Print or save as PDF
        </Button>
        <Button onClick={() => download(`/timetables/${tt.id}/ics?type=${view.type}&id=${view.id}`, `${name}.ics`).catch((e) => toast(errorMessage(e), 'error'))}>
          Add to my calendar
        </Button>
      </PageHeader>
      {!student && (
        <div className="no-print mb-4">
          <ViewPicker problem={tt.problem} view={view} onChange={setView} />
        </div>
      )}
      <h2 className="mb-3 hidden text-xl font-bold print:block">{name}</h2>
      <TimetableGrid problem={tt.problem} events={tt.events} view={view} />
      <p className="no-print mt-3 text-sm text-muted">The calendar file works with Google Calendar, Outlook and Apple Calendar, and repeats every week of the term.</p>
    </>
  );
}

/** Shown once to a student who has not said which class they are in. */
function ChooseClass({ message, onDone }) {
  const { chooseClass } = useAuth();
  const [sectionId, setSectionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await chooseClass(sectionId);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Which class are you in?" description="You will see only your own class's timetable." />
      <form className="max-w-md space-y-4 rounded-lg border border-line bg-sheet p-6" onSubmit={save}>
        {message?.includes('again') && <Notice>{message}</Notice>}
        <Field label="Your class" hint="Pick carefully. After this only your department can change it.">
          <ClassSelect value={sectionId} onChange={setSectionId} required aria-label="Your class" />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" busy={busy} disabled={!sectionId} className="w-full">
          Show my timetable
        </Button>
      </form>
    </>
  );
}
