-- Exercise library: free-exercise-db rows plus custom exercises.
CREATE TABLE exercises (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'weight_reps' CHECK (type IN (
    'weight_reps', 'reps_only', 'bodyweight_reps', 'bodyweight_assisted_reps',
    'duration', 'weight_duration', 'distance_duration', 'short_distance_weight'
  )),
  type_overridden INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  force TEXT,
  level TEXT,
  mechanic TEXT,
  equipment TEXT,
  primary_muscles TEXT NOT NULL DEFAULT '[]',
  secondary_muscles TEXT NOT NULL DEFAULT '[]',
  instructions TEXT NOT NULL DEFAULT '[]',
  images TEXT NOT NULL DEFAULT '[]',
  is_custom INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_exercises_name ON exercises(name);

CREATE VIRTUAL TABLE exercises_fts USING fts5(
  name, primary_muscles, equipment,
  content = 'exercises', content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER exercises_fts_ai AFTER INSERT ON exercises BEGIN
  INSERT INTO exercises_fts(rowid, name, primary_muscles, equipment)
  VALUES (new.rowid, new.name, new.primary_muscles, new.equipment);
END;
CREATE TRIGGER exercises_fts_ad AFTER DELETE ON exercises BEGIN
  INSERT INTO exercises_fts(exercises_fts, rowid, name, primary_muscles, equipment)
  VALUES ('delete', old.rowid, old.name, old.primary_muscles, old.equipment);
END;
CREATE TRIGGER exercises_fts_au AFTER UPDATE OF name, primary_muscles, equipment ON exercises BEGIN
  INSERT INTO exercises_fts(exercises_fts, rowid, name, primary_muscles, equipment)
  VALUES ('delete', old.rowid, old.name, old.primary_muscles, old.equipment);
  INSERT INTO exercises_fts(rowid, name, primary_muscles, equipment)
  VALUES (new.rowid, new.name, new.primary_muscles, new.equipment);
END;

-- Reusable templates ("Push A").
CREATE TABLE routines (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE routine_exercises (
  id INTEGER PRIMARY KEY,
  routine_id INTEGER NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercises(id),
  position INTEGER NOT NULL,
  superset_group INTEGER,
  notes TEXT,
  rest_seconds INTEGER
);
CREATE INDEX idx_routine_exercises_routine ON routine_exercises(routine_id, position);

CREATE TABLE routine_sets (
  id INTEGER PRIMARY KEY,
  routine_exercise_id INTEGER NOT NULL REFERENCES routine_exercises(id) ON DELETE CASCADE,
  set_number INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'normal' CHECK (type IN ('warmup', 'normal', 'failure', 'dropset')),
  reps_min INTEGER,
  reps_max INTEGER,
  weight_kg REAL,
  rpe REAL,
  duration_s INTEGER,
  distance_m REAL
);
CREATE INDEX idx_routine_sets_block ON routine_sets(routine_exercise_id, set_number);

-- One workout per (London, 04:00-rollover) day.
CREATE TABLE workouts (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,
  name TEXT,
  notes TEXT,
  routine_id INTEGER REFERENCES routines(id) ON DELETE SET NULL,
  start_time TEXT,
  end_time TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_workouts_updated ON workouts(updated_at);

-- An exercise block within a workout.
CREATE TABLE workout_exercises (
  id INTEGER PRIMARY KEY,
  workout_id INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercises(id),
  position INTEGER NOT NULL,
  superset_group INTEGER,
  notes TEXT,
  rest_seconds INTEGER,
  UNIQUE (workout_id, exercise_id)
);
CREATE INDEX idx_workout_exercises_exercise ON workout_exercises(exercise_id, workout_id);

CREATE TABLE sets (
  id INTEGER PRIMARY KEY,
  workout_exercise_id INTEGER NOT NULL REFERENCES workout_exercises(id) ON DELETE CASCADE,
  set_number INTEGER NOT NULL,
  type TEXT NOT NULL DEFAULT 'normal' CHECK (type IN ('warmup', 'normal', 'failure', 'dropset')),
  reps INTEGER,
  weight_kg REAL,
  duration_s INTEGER,
  distance_m REAL,
  rpe REAL,
  is_planned INTEGER NOT NULL DEFAULT 0,
  target_reps_min INTEGER,
  target_reps_max INTEGER,
  target_weight_kg REAL,
  target_rpe REAL,
  target_duration_s INTEGER,
  target_distance_m REAL,
  notes TEXT,
  performed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_sets_block ON sets(workout_exercise_id, set_number);

CREATE TABLE body_measurements (
  date TEXT PRIMARY KEY,
  weight_kg REAL,
  fat_percent REAL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Keep updated_at current. recursive_triggers is off by default, so the inner UPDATE does not re-fire.
CREATE TRIGGER exercises_touch AFTER UPDATE ON exercises WHEN new.updated_at = old.updated_at BEGIN
  UPDATE exercises SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = new.id;
END;
CREATE TRIGGER routines_touch AFTER UPDATE ON routines WHEN new.updated_at = old.updated_at BEGIN
  UPDATE routines SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = new.id;
END;
CREATE TRIGGER workouts_touch AFTER UPDATE ON workouts WHEN new.updated_at = old.updated_at BEGIN
  UPDATE workouts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = new.id;
END;
CREATE TRIGGER sets_touch AFTER UPDATE ON sets WHEN new.updated_at = old.updated_at BEGIN
  UPDATE sets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = new.id;
END;
CREATE TRIGGER body_measurements_touch AFTER UPDATE ON body_measurements WHEN new.updated_at = old.updated_at BEGIN
  UPDATE body_measurements SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE date = new.date;
END;

-- Any change to a workout's blocks or sets bumps the workout, so ?updated_since= sees it.
CREATE TRIGGER workout_exercises_bump_ai AFTER INSERT ON workout_exercises BEGIN
  UPDATE workouts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = new.workout_id;
END;
CREATE TRIGGER workout_exercises_bump_au AFTER UPDATE ON workout_exercises BEGIN
  UPDATE workouts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = new.workout_id;
END;
CREATE TRIGGER workout_exercises_bump_ad AFTER DELETE ON workout_exercises BEGIN
  UPDATE workouts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = old.workout_id;
END;
CREATE TRIGGER sets_bump_ai AFTER INSERT ON sets BEGIN
  UPDATE workouts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = (SELECT workout_id FROM workout_exercises WHERE id = new.workout_exercise_id);
END;
CREATE TRIGGER sets_bump_au AFTER UPDATE ON sets BEGIN
  UPDATE workouts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = (SELECT workout_id FROM workout_exercises WHERE id = new.workout_exercise_id);
END;
CREATE TRIGGER sets_bump_ad AFTER DELETE ON sets BEGIN
  UPDATE workouts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = (SELECT workout_id FROM workout_exercises WHERE id = old.workout_exercise_id);
END;
