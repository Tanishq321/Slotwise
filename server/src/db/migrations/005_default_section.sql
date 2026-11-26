-- The class whose timetable opens first on screen (for example the HOD's own group).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS default_section_id TEXT REFERENCES sections(id) ON DELETE SET NULL;
