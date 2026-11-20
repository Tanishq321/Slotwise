-- Per-offering overrides for real timetables where one subject has, say, a 2-hour
-- block once a week and a 1-hour class twice (each becomes its own offering).
-- NULL means "use the course defaults" (course.sessions_per_week, lab length from settings).
ALTER TABLE offerings ADD COLUMN IF NOT EXISTS duration INT CHECK (duration BETWEEN 1 AND 6);
ALTER TABLE offerings ADD COLUMN IF NOT EXISTS sessions_per_week INT CHECK (sessions_per_week BETWEEN 1 AND 10);
ALTER TABLE offerings ADD COLUMN IF NOT EXISTS max_sessions_per_day INT CHECK (max_sessions_per_day BETWEEN 1 AND 6);

ALTER TABLE baskets ADD COLUMN IF NOT EXISTS duration INT NOT NULL DEFAULT 1 CHECK (duration BETWEEN 1 AND 6);
ALTER TABLE baskets ADD COLUMN IF NOT EXISTS max_sessions_per_day INT CHECK (max_sessions_per_day BETWEEN 1 AND 6);
