-- Master data lives in PostgreSQL. Generated timetables (versions) live in MongoDB.

CREATE TABLE IF NOT EXISTS settings (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  institution     TEXT NOT NULL DEFAULT 'My Institute',
  days            JSONB NOT NULL,
  periods_per_day INT NOT NULL CHECK (periods_per_day BETWEEN 1 AND 16),
  breaks          JSONB NOT NULL DEFAULT '[]',
  lab_duration    INT NOT NULL DEFAULT 2 CHECK (lab_duration BETWEEN 1 AND 4),
  period_times    JSONB NOT NULL DEFAULT '[]',
  term_start      DATE,
  term_weeks      INT NOT NULL DEFAULT 16
);

CREATE TABLE IF NOT EXISTS faculty (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT,
  department    TEXT,
  max_per_day   INT NOT NULL DEFAULT 4 CHECK (max_per_day BETWEEN 1 AND 12),
  max_per_week  INT NOT NULL DEFAULT 18 CHECK (max_per_week BETWEEN 1 AND 60),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS faculty_name_idx ON faculty (lower(name));

CREATE TABLE IF NOT EXISTS rooms (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL CHECK (type IN ('lecture', 'lab')),
  capacity   INT NOT NULL CHECK (capacity > 0),
  building   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sections (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  program    TEXT,
  semester   INT,
  size       INT NOT NULL CHECK (size > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS courses (
  id                TEXT PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('lecture', 'lab')),
  sessions_per_week INT NOT NULL CHECK (sessions_per_week BETWEEN 1 AND 10),
  department        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A course taught by one teacher to one or more sections (combined classes allowed).
CREATE TABLE IF NOT EXISTS offerings (
  id         TEXT PRIMARY KEY,
  course_id  TEXT NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  faculty_id TEXT NOT NULL REFERENCES faculty(id) ON DELETE RESTRICT,
  size       INT CHECK (size > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS offering_sections (
  offering_id TEXT NOT NULL REFERENCES offerings(id) ON DELETE CASCADE,
  section_id  TEXT NOT NULL REFERENCES sections(id) ON DELETE RESTRICT,
  PRIMARY KEY (offering_id, section_id)
);
CREATE INDEX IF NOT EXISTS offering_sections_section_idx ON offering_sections (section_id);

-- NEP elective baskets: several sections choose between options that run in parallel.
CREATE TABLE IF NOT EXISTS baskets (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  sessions_per_week INT NOT NULL CHECK (sessions_per_week BETWEEN 1 AND 10),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS basket_sections (
  basket_id  TEXT NOT NULL REFERENCES baskets(id) ON DELETE CASCADE,
  section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE RESTRICT,
  PRIMARY KEY (basket_id, section_id)
);
CREATE TABLE IF NOT EXISTS basket_options (
  offering_id TEXT PRIMARY KEY,
  basket_id   TEXT NOT NULL REFERENCES baskets(id) ON DELETE CASCADE,
  course_id   TEXT NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  faculty_id  TEXT NOT NULL REFERENCES faculty(id) ON DELETE RESTRICT,
  size        INT NOT NULL CHECK (size > 0),
  UNIQUE (basket_id, faculty_id)
);

-- Which courses a teacher is qualified for (used for substitute suggestions).
CREATE TABLE IF NOT EXISTS faculty_can_teach (
  faculty_id TEXT NOT NULL REFERENCES faculty(id) ON DELETE CASCADE,
  course_id  TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  PRIMARY KEY (faculty_id, course_id)
);

-- Availability rules, e.g. "Dr. Sharma can't teach before 10 on Mondays".
CREATE TABLE IF NOT EXISTS constraints (
  id           SERIAL PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('faculty', 'section')),
  subject_id   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('unavailable', 'avoid')),
  day          INT NOT NULL CHECK (day >= 0),
  period_from  INT NOT NULL CHECK (period_from >= 0),
  period_to    INT NOT NULL CHECK (period_to >= period_from),
  note         TEXT,
  source_text  TEXT,
  created_by   INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS constraints_subject_idx ON constraints (subject_type, subject_id);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('admin', 'hod', 'faculty', 'student')),
  faculty_id    TEXT REFERENCES faculty(id) ON DELETE SET NULL,
  section_id    TEXT REFERENCES sections(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));
