import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import './index.css';
import { AuthProvider, RequireAuth, useAuth } from './auth.jsx';
import { ToastProvider } from './components/ui.jsx';
import { Layout } from './components/Layout.jsx';
import { Login } from './pages/Login.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { TimetablePage } from './pages/TimetablePage.jsx';
import { MyTimetable } from './pages/MyTimetable.jsx';
import { Compare } from './pages/Compare.jsx';
import { DataPage } from './pages/DataPage.jsx';
import { Rules } from './pages/Rules.jsx';
import { Settings } from './pages/Settings.jsx';
import { Users } from './pages/Users.jsx';

function Home() {
  const { isEditor } = useAuth();
  return isEditor ? <Dashboard /> : <Navigate to="/my" replace />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route element={<RequireAuth><Layout /></RequireAuth>}>
              <Route index element={<Home />} />
              <Route path="my" element={<MyTimetable />} />
              <Route path="timetables/:id" element={<RequireAuth editor><TimetablePage /></RequireAuth>} />
              <Route path="compare" element={<RequireAuth editor><Compare /></RequireAuth>} />
              <Route path="data/:tab" element={<RequireAuth editor><DataPage /></RequireAuth>} />
              <Route path="rules" element={<RequireAuth editor><Rules /></RequireAuth>} />
              <Route path="settings" element={<RequireAuth editor><Settings /></RequireAuth>} />
              <Route path="users" element={<RequireAuth admin><Users /></RequireAuth>} />
              <Route path="*" element={<p className="text-muted">That page does not exist.</p>} />
            </Route>
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
