import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth.jsx';
import { errorMessage } from '../api.js';
import { Button, Field, Input, Notice } from '../components/ui.jsx';

const DEMO = [
  ['admin@samay.dev', 'Admin'],
  ['hod@samay.dev', 'Head of department'],
  ['faculty@samay.dev', 'Teacher'],
  ['student@samay.dev', 'Student'],
];

export function Login() {
  const { user, login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  if (user) return <Navigate to={location.state?.from || '/'} replace />;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await login(form.email, form.password);
      else await register(form.name, form.email, form.password);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen md:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden bg-ink p-12 text-white md:flex md:flex-col">
        <div className="flex items-center gap-2.5">
          <img src="/favicon.svg" alt="" className="h-9 w-9 rounded-md ring-1 ring-white/20" />
          <span className="font-display text-2xl font-bold">Samay</span>
        </div>
        <h1 className="mt-auto max-w-md text-5xl font-bold leading-[1.05]">Every class has a room, a teacher and a time. None of them clash.</h1>
        <p className="mt-5 max-w-md text-lg text-white/75">
          Samay builds the semester timetable from your teachers, rooms and NEP electives in seconds, then lets you fix anything by dragging it.
        </p>
        <MiniGrid />
      </section>
      <section className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <h2 className="text-3xl font-bold">{mode === 'login' ? 'Log in' : 'Create an account'}</h2>
          <form className="mt-6 space-y-4" onSubmit={submit}>
            {mode === 'register' && (
              <Field label="Full name">
                <Input value={form.name} onChange={set('name')} autoComplete="name" required />
              </Field>
            )}
            <Field label="Email">
              <Input type="email" value={form.email} onChange={set('email')} autoComplete="email" required />
            </Field>
            <Field label="Password" hint={mode === 'register' ? 'At least 8 characters' : undefined}>
              <Input type="password" value={form.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required />
            </Field>
            {error && <Notice tone="error">{error}</Notice>}
            <Button type="submit" busy={busy} className="w-full py-2.5">
              {mode === 'login' ? 'Log in' : 'Create account'}
            </Button>
          </form>
          <p className="mt-4 text-sm text-muted">
            {mode === 'login' ? 'New here? ' : 'Already have an account? '}
            <button className="font-bold text-ink underline" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? 'Create an account' : 'Log in'}
            </button>
          </p>
          <div className="mt-8 border-t border-line pt-5">
            <p className="text-sm font-bold">Try the demo</p>
            <p className="text-sm text-muted">Password for all: Samay@2026</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {DEMO.map(([email, label]) => (
                <Button key={email} variant="secondary" onClick={() => (setMode('login'), setForm({ name: '', email, password: 'Samay@2026' }))}>
                  {label}
                </Button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// A small illustrative week: one marigold block being "dropped" into a free slot.
function MiniGrid() {
  const blocks = [
    [0, 0, 2, '#7d8bd1'], [1, 1, 1, '#5fae8c'], [2, 0, 1, '#d58a62'], [3, 2, 1, '#9b7cc9'],
    [4, 0, 1, '#5aa1c2'], [0, 3, 1, '#c7a23b'], [2, 2, 2, '#7d8bd1'], [4, 3, 1, '#d58a62'],
  ];
  return (
    <div className="mt-10 grid grid-cols-5 grid-rows-4 gap-1.5 opacity-90" aria-hidden="true" style={{ height: 150, maxWidth: 420 }}>
      {Array.from({ length: 20 }, (_, i) => (
        <div key={i} className="rounded-sm bg-white/[0.06]" style={{ gridColumn: (i % 5) + 1, gridRow: Math.floor(i / 5) + 1 }} />
      ))}
      {blocks.map(([c, r, s, color], i) => (
        <div key={`b${i}`} className="rounded-sm" style={{ gridColumn: c + 1, gridRow: `${r + 1} / span ${s}`, background: color, opacity: 0.85 }} />
      ))}
      <div className="rounded-sm bg-marigold ring-2 ring-white" style={{ gridColumn: 3, gridRow: 4 }} />
    </div>
  );
}
