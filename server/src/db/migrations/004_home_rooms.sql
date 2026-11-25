-- A class's usual room. The generator tries it first so students don't change rooms every period.
ALTER TABLE sections ADD COLUMN IF NOT EXISTS home_room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL;
