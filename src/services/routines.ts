import type { Ctx } from "../app.ts";
import type { DB } from "../db.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import type { PlanBlock, RoutineInput, RoutinePatch } from "../schemas.ts";
import { requireExercise } from "./exercises.ts";
import { roundKg } from "./load.ts";
import { planSession, type WorkoutDetail } from "./workouts.ts";

type RoutineRow = { id: number; name: string; notes: string | null; created_at: string; updated_at: string };
type RoutineBlockRow = {
  id: number;
  exercise_id: string;
  position: number;
  superset_group: number | null;
  notes: string | null;
  rest_seconds: number | null;
  name: string;
  type: string;
};
type RoutineSetRow = {
  routine_exercise_id: number;
  set_number: number;
  type: string;
  reps_min: number | null;
  reps_max: number | null;
  weight_kg: number | null;
  rpe: number | null;
  duration_s: number | null;
  distance_m: number | null;
};

function requireRoutine(db: DB, id: number): RoutineRow {
  const r = db.query<RoutineRow, [number]>("SELECT * FROM routines WHERE id = ?").get(id);
  if (!r) {
    const names = db.query<{ id: number; name: string }, []>("SELECT id, name FROM routines ORDER BY name").all();
    throw notFound(`Routine ${id}`, { routines: names });
  }
  return r;
}

const lastPerformed = (db: DB, id: number) =>
  db
    .query<{ d: string | null }, [number]>(
      `SELECT MAX(w.date) AS d FROM workouts w WHERE w.routine_id = ?
         AND EXISTS (SELECT 1 FROM workout_exercises we JOIN sets s ON s.workout_exercise_id = we.id
                     WHERE we.workout_id = w.id AND s.is_planned = 0)`,
    )
    .get(id)!.d;

export function getRoutine(ctx: Ctx, id: number) {
  const { db } = ctx;
  const r = requireRoutine(db, id);
  const blocks = db
    .query<RoutineBlockRow, [number]>(
      `SELECT re.*, e.name, e.type FROM routine_exercises re JOIN exercises e ON e.id = re.exercise_id
       WHERE re.routine_id = ? ORDER BY re.position`,
    )
    .all(id);
  const sets = db
    .query<RoutineSetRow, [number]>(
      `SELECT rs.* FROM routine_sets rs JOIN routine_exercises re ON re.id = rs.routine_exercise_id
       WHERE re.routine_id = ? ORDER BY rs.set_number`,
    )
    .all(id);
  return {
    id: r.id,
    name: r.name,
    notes: r.notes,
    last_performed: lastPerformed(db, id),
    exercises: blocks.map((b) => ({
      position: b.position,
      exercise: { id: b.exercise_id, name: b.name, type: b.type },
      superset_group: b.superset_group,
      notes: b.notes,
      rest_seconds: b.rest_seconds,
      sets: sets
        .filter((s) => s.routine_exercise_id === b.id)
        .map((s) => ({
          set_number: s.set_number,
          type: s.type,
          reps_min: s.reps_min,
          reps_max: s.reps_max,
          weight_kg: roundKg(s.weight_kg),
          rpe: s.rpe,
          duration_s: s.duration_s,
          distance_m: s.distance_m,
        })),
    })),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
export type RoutineDetail = ReturnType<typeof getRoutine>;

export function listRoutines(ctx: Ctx) {
  const rows = ctx.db
    .query<{ id: number; name: string; notes: string | null; names: string; updated_at: string }, []>(
      `SELECT r.id, r.name, r.notes, r.updated_at,
         (SELECT json_group_array(name) FROM (
            SELECT e.name FROM routine_exercises re JOIN exercises e ON e.id = re.exercise_id
            WHERE re.routine_id = r.id ORDER BY re.position)) AS names
       FROM routines r ORDER BY r.name`,
    )
    .all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    notes: r.notes,
    exercises: JSON.parse(r.names) as string[],
    last_performed: lastPerformed(ctx.db, r.id),
    updated_at: r.updated_at,
  }));
}

function validateBlocks(db: DB, blocks: PlanBlock[]) {
  const seen = new Set<string>();
  for (const b of blocks) {
    requireExercise(db, b.exercise_id);
    if (seen.has(b.exercise_id)) throw badRequest(`Exercise '${b.exercise_id}' appears twice; put all its sets in one block`);
    seen.add(b.exercise_id);
    for (const s of b.sets) {
      const min = s.reps_min ?? s.reps;
      const max = s.reps_max ?? s.reps;
      if (min != null && max != null && min > max) throw badRequest("reps_min must be <= reps_max");
    }
  }
}

function insertBlocks(db: DB, routineId: number, blocks: PlanBlock[]) {
  const insBlock = db.query(
    `INSERT INTO routine_exercises (routine_id, exercise_id, position, superset_group, notes, rest_seconds)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insSet = db.query(
    `INSERT INTO routine_sets (routine_exercise_id, set_number, type, reps_min, reps_max, weight_kg, rpe, duration_s, distance_m)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  blocks.forEach((b, i) => {
    const blockId = Number(
      insBlock.run(routineId, b.exercise_id, i + 1, b.superset_group ?? null, b.notes ?? null, b.rest_seconds ?? null).lastInsertRowid,
    );
    b.sets.forEach((s, j) =>
      insSet.run(
        blockId,
        j + 1,
        s.type ?? "normal",
        s.reps_min ?? s.reps ?? null,
        s.reps_max ?? s.reps ?? null,
        s.weight_kg ?? null,
        s.rpe ?? null,
        s.duration_s ?? null,
        s.distance_m ?? null,
      ),
    );
  });
}

function assertNameFree(db: DB, name: string, exceptId?: number) {
  const clash = db
    .query<{ id: number }, [string, number]>("SELECT id FROM routines WHERE lower(name) = lower(?) AND id != ?")
    .get(name, exceptId ?? 0);
  if (clash) throw conflict(`A routine called '${name}' already exists`, { routine_id: clash.id });
}

export function createRoutine(ctx: Ctx, input: RoutineInput): RoutineDetail {
  const { db } = ctx;
  validateBlocks(db, input.exercises);
  assertNameFree(db, input.name);
  const id = db.transaction(() => {
    const id = Number(
      db.query("INSERT INTO routines (name, notes) VALUES (?, ?)").run(input.name, input.notes ?? null).lastInsertRowid,
    );
    insertBlocks(db, id, input.exercises);
    return id;
  })();
  return getRoutine(ctx, id);
}

/** Name/notes patch in place; `exercises`, when given, replaces every block. */
export function updateRoutine(ctx: Ctx, id: number, patch: RoutinePatch): RoutineDetail {
  const { db } = ctx;
  requireRoutine(db, id);
  if (patch.name === undefined && patch.notes === undefined && patch.exercises === undefined) {
    throw badRequest("Nothing to update");
  }
  if (patch.exercises) validateBlocks(db, patch.exercises);
  if (patch.name) assertNameFree(db, patch.name, id);
  db.transaction(() => {
    if (patch.name !== undefined) db.query("UPDATE routines SET name = ? WHERE id = ?").run(patch.name, id);
    if (patch.notes !== undefined) db.query("UPDATE routines SET notes = ? WHERE id = ?").run(patch.notes, id);
    if (patch.exercises) {
      db.query("DELETE FROM routine_exercises WHERE routine_id = ?").run(id);
      insertBlocks(db, id, patch.exercises);
      db.query("UPDATE routines SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
    }
  })();
  return getRoutine(ctx, id);
}

export function deleteRoutine(ctx: Ctx, id: number) {
  requireRoutine(ctx.db, id);
  ctx.db.query("DELETE FROM routines WHERE id = ?").run(id);
  return { deleted: true, routine_id: id };
}

/** Copy a routine into a day's workout as planned sets (merging if the day already has a workout). */
export function startRoutine(ctx: Ctx, id: number, date?: string): WorkoutDetail {
  const r = getRoutine(ctx, id);
  return planSession(
    ctx,
    {
      date,
      name: r.name,
      notes: r.notes ?? undefined,
      exercises: r.exercises.map((b) => ({
        exercise_id: b.exercise.id,
        superset_group: b.superset_group ?? undefined,
        notes: b.notes ?? undefined,
        rest_seconds: b.rest_seconds ?? undefined,
        sets: b.sets.map((s) => ({
          type: s.type as PlanBlock["sets"][number]["type"],
          reps_min: s.reps_min ?? undefined,
          reps_max: s.reps_max ?? undefined,
          weight_kg: s.weight_kg ?? undefined,
          rpe: s.rpe ?? undefined,
          duration_s: s.duration_s ?? undefined,
          distance_m: s.distance_m ?? undefined,
        })),
      })),
    },
    { routine_id: id },
  );
}
