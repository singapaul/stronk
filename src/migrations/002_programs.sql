-- Programs: an ordered list of routines run on repeat. Each pass through the list is a cycle with
-- its own copy of the target sets, so progression is recorded cycle by cycle.
CREATE TABLE programs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  notes TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- At most one active program.
CREATE UNIQUE INDEX idx_programs_one_active ON programs(is_active) WHERE is_active = 1;

CREATE TABLE program_slots (
  id INTEGER PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  routine_id INTEGER NOT NULL REFERENCES routines(id),
  UNIQUE (program_id, position)
);

CREATE TABLE cycles (
  id INTEGER PRIMARY KEY,
  program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  targets_source TEXT NOT NULL CHECK (targets_source IN ('initial', 'carried_over', 'claude')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (program_id, number)
);

-- A cycle's targets per slot, mirroring routine_exercises / routine_sets.
CREATE TABLE cycle_exercises (
  id INTEGER PRIMARY KEY,
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  slot_id INTEGER NOT NULL REFERENCES program_slots(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercises(id),
  position INTEGER NOT NULL,
  superset_group INTEGER,
  notes TEXT,
  rest_seconds INTEGER,
  UNIQUE (cycle_id, slot_id, exercise_id)
);
CREATE INDEX idx_cycle_exercises_slot ON cycle_exercises(cycle_id, slot_id, position);

CREATE TABLE cycle_sets (
  id INTEGER PRIMARY KEY,
  cycle_exercise_id INTEGER NOT NULL REFERENCES cycle_exercises(id) ON DELETE CASCADE,
  set_number INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'normal' CHECK (type IN ('warmup', 'normal', 'failure', 'dropset')),
  reps_min INTEGER,
  reps_max INTEGER,
  weight_kg REAL,
  rpe REAL,
  duration_s INTEGER,
  distance_m REAL
);
CREATE INDEX idx_cycle_sets_block ON cycle_sets(cycle_exercise_id, set_number);

CREATE TABLE cycle_slot_skips (
  cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  slot_id INTEGER NOT NULL REFERENCES program_slots(id) ON DELETE CASCADE,
  skipped_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (cycle_id, slot_id)
);

-- Which cycle slot a workout was started for (null for ad-hoc workouts).
ALTER TABLE workouts ADD COLUMN cycle_id INTEGER REFERENCES cycles(id) ON DELETE SET NULL;
ALTER TABLE workouts ADD COLUMN slot_id INTEGER REFERENCES program_slots(id) ON DELETE SET NULL;
CREATE INDEX idx_workouts_cycle_slot ON workouts(cycle_id, slot_id);

CREATE TRIGGER programs_touch AFTER UPDATE ON programs WHEN new.updated_at = old.updated_at BEGIN
  UPDATE programs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = new.id;
END;
CREATE TRIGGER cycles_touch AFTER UPDATE ON cycles WHEN new.updated_at = old.updated_at BEGIN
  UPDATE cycles SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = new.id;
END;
