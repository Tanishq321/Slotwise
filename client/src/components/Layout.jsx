import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../auth.jsx';

const linkClass = ({ isActive }) =>
  `block rounded-md px-3 py-2 text-sm font-bold ${isActive ? 'bg-sheet text-ink shadow-[inset_3px_0_0_var(--color-marigold)]' : 'text-ink-soft hover:bg-sheet/70 hover:text-ink'}`;

export function Layout() {
  const { user, isEditor, isAdmin, logout } = useAuth();
  const links = [
    ...(isEditor ? [{ to: '/', label: 'Overview', end: true }] : []),
    { to: '/my', label: 'My timetable' },
    ...(isEditor
      ? [
          { to: '/data/faculty', label: 'Teachers & courses' },
          { to: '/rules', label: 'Availability rules' },
          { to: '/compare', label: 'Compare versions' },
          { to: '/settings', label: 'Days & periods' },
        ]
      : []),
    ...(isAdmin ? [{ to: '/users', label: 'People & roles' }] : []),
  ];
  return (
    <div className="min-h-screen md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-sheet focus:p-2">
        Skip to content
      </a>
      <aside className="no-print border-b border-line bg-paper md:sticky md:top-0 md:flex md:h-screen md:w-60 md:flex-col md:border-b-0 md:border-r">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <img src="/favicon.svg" alt="" className="h-8 w-8" />
          <span className="font-display text-2xl font-bold">Slotwise</span>
          <button className="ml-auto text-sm text-ink-soft underline md:hidden" onClick={logout}>
            Log out
          </button>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:block md:space-y-0.5 md:pb-0" aria-label="Main">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className={linkClass}>
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto hidden border-t border-line px-5 py-4 text-sm md:block">
          <p className="font-bold">{user?.name}</p>
          <p className="text-muted">{{ admin: 'Admin', hod: 'Head of department', faculty: 'Teacher', student: 'Student' }[user?.role] || user?.role}</p>
          <button className="mt-2 text-ink-soft underline hover:text-ink" onClick={logout}>
            Log out
          </button>
        </div>
      </aside>
      <main id="main" className="print-full mx-auto w-full max-w-7xl flex-1 px-4 py-8 md:px-8">
        <Outlet />
      </main>
    </div>
  );
}
