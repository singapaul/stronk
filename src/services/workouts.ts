import type { Ctx } from "../app.ts";
import type { DB } from "../db.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import type {
  BlockPatch,
  CompletePlannedSetInput,
  LogSetInput,
  LogWorkoutInput,
  PerformedSet,
  PlanBlock,
  PlanSessionInput,
  SetPatch,
  WorkoutListInput,
  WorkoutPatch,
} from "../schemas.ts";
import { deriveStatus, trainingDay, type WorkoutStatus } from "./dates.ts";
import { requireExercise } from "./exercises.ts";
import { bodyweightLookup, effectiveLoad, isWorking, roundKg, typeWarnings } from "./load.ts";
import { anyPr, prFlags, type PrFlags } from "./stats.ts";

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type WorkoutRow = {
  id: number;
  date: string;
  name: string | null;
  notes: string | null;
  routine_id: number | null;
  start_time: string | null;
  end_time: string | null;
  created_at: string;
  updated_at: string;
};

type BlockRow = {
  id: number;
  workout_id: number;
  exercise_id: string;
  position: number;
  superset_group: number | null;
  notes: string | null;
  rest_seconds: number | null;
};

export type SetRow = {
  id: number;
  workout_exercise_id: number;
  set_number: number;
  type: string;
  reps: number | null;
  weight_kg: number | null;
  duration_s: number | null;
  distance_m: number | null;
  rpe: number | null;
  is_planned: number;
  target_reps_min: number | null;
  target_reps_max: number | null;
  target_weight_kg: number | null;
  target_rpe: number | null;
  target_duration_s: number | null;
  target_distance_m: number | null;
  notes: string | null;
  performed_at: string | null;
  created_at: string;
  updated_at: string;
};

export const today = (ctx: Ctx) => trainingDay(ctx.clock());

const nowIso = (ctx: Ctx) => ctx.clock().toISOString();

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

export function toSet(s: SetRow, opts: { skipped?: boolean } = {}) {
  const hasTarget =
    s.target_reps_min != null ||
    s.target_reps_max != null ||
    s.target_weight_kg != null ||
    s.target_rpe != null ||
    s.target_duration_s != null ||
    s.target_distance_m != null;
  return {
    id: s.id,
    set_number: s.set_number,
    type: s.type,
    is_planned: s.is_planned === 1,
    ...(opts.skipped ? { skipped: true } : {}),
    reps: s.reps,
    weight_kg: roundKg(s.weight_kg),
    duration_s: s.duration_s,
    distance_m: s.distance_m,
    rpe: s.rpe,
    notes: s.notes,
    target: hasTarget
      ? {
          reps_min: s.target_reps_min,
          reps_max: s.target_reps_max,
          weight_kg: roundKg(s.target_weight_kg),
          rpe: s.target_rpe,
          duration_s: s.target_duration_s,
          distance_m: s.target_distance_m,
        }
      : null,
    performed_at: s.performed_at,
  };
}
export type SetOut = ReturnType<typeof toSet>;

export type WorkoutDetail = {
  id: number;
  date: string;
  name: string | null;
  notes: string | null;
  routine_id: number | null;
  status: WorkoutStatus;
  start_time: string | null;
  end_time: string | null;
  duration_min: number | null;
  totals: { performed_sets: number; planned_sets: number; volume_kg: number };
  exercises: {
    block_id: number;
    position: number;
    exercise: { id: string; name: string; type: string };
    superset_group: number | null;
    notes: string | null;
    rest_seconds: number | null;
    sets: SetOut[];
  }[];
  created_at: string;
  updated_at: string;
};

/** Stored times win (backfills); otherwise derive from when sets were performed. */
function timing(w: WorkoutRow, performedAt: string[]) {
  const sorted = [...performedAt].sort();
  const start = w.start_time ?? sorted[0] ?? null;
  const end = w.end_time ?? sorted[sorted.length - 1] ?? null;
  const duration =
    start && end ? Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60_000)) : null;
  return { start_time: start, end_time: end, duration_min: duration };
}

function findWorkout(db: DB, id: number) {
  return db.query<WorkoutRow, [number]>("SELECT * FROM workouts WHERE id = ?").get(id);
}

function requireWorkout(db: DB, id: number): WorkoutRow {
  const w = findWorkout(db, id);
  if (!w) throw notFound(`Workout ${id}`);
  return w;
}

export function getWorkout(ctx: Ctx, id: number): WorkoutDetail {
  const { db } = ctx;
  const w = requireWorkout(db, id);
  const blocks = db
    .query<BlockRow & { name: string; type: string }, [number]>(
      `SELECT we.*, e.name, e.type FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id
       WHERE we.workout_id = ? ORDER BY we.position, we.id`,
    )
    .all(id);
  const sets = db
    .query<SetRow, [number]>(
      `SELECT s.* FROM sets s JOIN workout_exercises we ON we.id = s.workout_exercise_id
       WHERE we.workout_id = ? ORDER BY s.set_number, s.id`,
    )
    .all(id);
  const t = today(ctx);
  const bw = bodyweightLookup(db)(w.date);
  let volume = 0;
  let performed = 0;
  const byBlock = new Map<number, SetRow[]>();
  for (const s of sets) {
    const list = byBlock.get(s.workout_exercise_id) ?? [];
    list.push(s);
    byBlock.set(s.workout_exercise_id, list);
  }
  const exercises = blocks.map((b) => {
    const blockSets = byBlock.get(b.id) ?? [];
    for (const s of blockSets) {
      if (s.is_planned === 0) performed++;
      if (isWorking(s)) {
        const load = effectiveLoad(b.type, s.weight_kg, bw);
        if (load != null && load > 0) volume += load * s.reps!;
      }
    }
    return {
      block_id: b.id,
      position: b.position,
      exercise: { id: b.exercise_id, name: b.name, type: b.type },
      superset_group: b.superset_group,
      notes: b.notes,
      rest_seconds: b.rest_seconds,
      sets: blockSets.map((s) => toSet(s, { skipped: s.is_planned === 1 && w.date < t })),
    };
  });
  return {
    id: w.id,
    date: w.date,
    name: w.name,
    notes: w.notes,
    routine_id: w.routine_id,
    status: deriveStatus(w.date, t, performed),
    ...timing(
      w,
      sets.filter((s) => s.performed_at).map((s) => s.performed_at!),
    ),
    totals: { performed_sets: performed, planned_sets: sets.length - performed, volume_kg: Math.round(volume) },
    exercises,
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
}

export function getWorkoutByDate(ctx: Ctx, date: string): WorkoutDetail | null {
  const w = ctx.db.query<{ id: number }, [string]>("SELECT id FROM workouts WHERE date = ?").get(date);
  return w ? getWorkout(ctx, w.id) : null;
}

export type WorkoutSummary = {
  id: number;
  date: string;
  name: string | null;
  status: WorkoutStatus;
  performed_sets: number;
  planned_sets: number;
  exercises: string[];
  updated_at: string;
};

export function listWorkouts(ctx: Ctx, input: WorkoutListInput): WorkoutSummary[] {
  const rows = ctx.db
    .query<
      { id: number; date: string; name: string | null; updated_at: string; performed: number; planned: number; names: string | null },
      Record<string, string | number>
    >(
      `SELECT w.id, w.date, w.name, w.updated_at,
         (SELECT COUNT(*) FROM sets s JOIN workout_exercises we ON we.id = s.workout_exercise_id
            WHERE we.workout_id = w.id AND s.is_planned = 0) AS performed,
         (SELECT COUNT(*) FROM sets s JOIN workout_exercises we ON we.id = s.workout_exercise_id
            WHERE we.workout_id = w.id AND s.is_planned = 1) AS planned,
         (SELECT json_group_array(name) FROM (
            SELECT e.name FROM workout_exercises we JOIN exercises e ON e.id = we.exercise_id
            WHERE we.workout_id = w.id ORDER BY we.position)) AS names
       FROM workouts w
       WHERE w.date >= $from AND w.date <= $to AND w.updated_at > $since
       ORDER BY w.date DESC LIMIT $limit OFFSET $offset`,
    )
    .all({
      from: input.from ?? "0000-00-00",
      to: input.to ?? "9999-99-99",
      since: input.updated_since ? new Date(input.updated_since).toISOString() : "",
      limit: input.limit,
      offset: input.offset,
    });
  const t = today(ctx);
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    name: r.name,
    status: deriveStatus(r.date, t, r.performed),
    performed_sets: r.performed,
    planned_sets: r.planned,
    exercises: r.names ? (JSON.parse(r.names) as string[]) : [],
    updated_at: r.updated_at,
  }));
}

// ---------------------------------------------------------------------------
// Building blocks (all callers wrap these in a transaction)
// ---------------------------------------------------------------------------

/** Get or create the one workout for a date. Name/notes only fill empty fields (merge, never clobber). */
export function ensureWorkout(
  db: DB,
  date: string,
  fields: { name?: string; notes?: string; start_time?: string; end_time?: string; routine_id?: number } = {},
): WorkoutRow {
  db.query("INSERT INTO workouts (date) VALUES (?) ON CONFLICT(date) DO NOTHING").run(date);
  const p = {
    date,
    name: fields.name ?? null,
    notes: fields.notes ?? null,
    start: fields.start_time ? new Date(fields.start_time).toISOString() : null,
    end: fields.end_time ? new Date(fields.end_time).toISOString() : null,
    routine: fields.routine_id ?? null,
  };
  if (Object.values(fields).some((v) => v != null)) {
    db.query(
      `UPDATE workouts SET
         name = COALESCE(name, $name), notes = COALESCE(notes, $notes),
         start_time = COALESCE(start_time, $start), end_time = COALESCE(end_time, $end),
         routine_id = COALESCE(routine_id, $routine)
       WHERE date = $date`,
    ).run(p);
  }
  return db.query<WorkoutRow, [string]>("SELECT * FROM workouts WHERE date = ?").get(date)!;
}

/** Get or create the exercise's block in a workout, appended at the next position. Meta only fills empty fields. */
export function ensureBlock(
  db: DB,
  workoutId: number,
  exerciseId: string,
  meta: { notes?: string; superset_group?: number; rest_seconds?: number } = {},
): BlockRow {
  db.query(
    `INSERT INTO workout_exercises (workout_id, exercise_id, position)
     VALUES ($w, $e, (SELECT COALESCE(MAX(position), 0) + 1 FROM workout_exercises WHERE workout_id = $w))
     ON CONFLICT(workout_id, exercise_id) DO NOTHING`,
  ).run({ w: workoutId, e: exerciseId });
  if (meta.notes != null || meta.superset_group != null || meta.rest_seconds != null) {
    db.query(
      `UPDATE workout_exercises SET
         notes = COALESCE(notes, $notes), superset_group = COALESCE(superset_group, $ss),
         rest_seconds = COALESCE(rest_seconds, $rest)
       WHERE workout_id = $w AND exercise_id = $e`,
    ).run({
      w: workoutId,
      e: exerciseId,
      notes: meta.notes ?? null,
      ss: meta.superset_group ?? null,
      rest: meta.rest_seconds ?? null,
    });
  }
  return db
    .query<BlockRow, [number, string]>("SELECT * FROM workout_exercises WHERE workout_id = ? AND exercise_id = ?")
    .get(workoutId, exerciseId)!;
}

const nextSetNumber = (db: DB, blockId: number) =>
  db
    .query<{ n: number }, [number]>("SELECT COALESCE(MAX(set_number), 0) + 1 AS n FROM sets WHERE workout_exercise_id = ?")
    .get(blockId)!.n;

function assertMeasured(s: { reps?: number | null; duration_s?: number | null; distance_m?: number | null }) {
  if (s.reps == null && s.duration_s == null && s.distance_m == null) {
    throw badRequest("A performed set needs reps, duration_s or distance_m");
  }
}

/**
 * Record a performed set in a block. If the block has a planned set of the same kind (warm-up vs working)
 * still waiting, fill the lowest-numbered one (targets are kept); otherwise append a new set.
 */
function recordPerformedSet(db: DB, blockId: number, s: PerformedSet, performedAt: string | null) {
  const wantWarmup = s.type === "warmup";
  const planned = db
    .query<SetRow, [number, number]>(
      `SELECT * FROM sets WHERE workout_exercise_id = ? AND is_planned = 1
         AND (type = 'warmup') = ? ORDER BY set_number LIMIT 1`,
    )
    .get(blockId, wantWarmup ? 1 : 0);
  const values = {
    reps: s.reps ?? null,
    weight_kg: s.weight_kg ?? null,
    duration_s: s.duration_s ?? null,
    distance_m: s.distance_m ?? null,
    rpe: s.rpe ?? null,
    notes: s.notes ?? null,
    at: performedAt,
  };
  if (planned) {
    db.query(
      `UPDATE sets SET is_planned = 0, type = COALESCE($type, type), reps = $reps, weight_kg = $weight_kg,
         duration_s = $duration_s, distance_m = $distance_m, rpe = $rpe, notes = COALESCE($notes, notes),
         performed_at = $at
       WHERE id = $id`,
    ).run({ ...values, type: s.type ?? null, id: planned.id });
    return { id: planned.id, filled_planned: true };
  }
  const res = db
    .query(
      `INSERT INTO sets (workout_exercise_id, set_number, type, reps, weight_kg, duration_s, distance_m, rpe, notes, performed_at)
       VALUES ($block, $n, $type, $reps, $weight_kg, $duration_s, $distance_m, $rpe, $notes, $at)`,
    )
    .run({ ...values, block: blockId, n: nextSetNumber(db, blockId), type: s.type ?? "normal" });
  return { id: Number(res.lastInsertRowid), filled_planned: false };
}

function insertPlannedSet(db: DB, blockId: number, s: PlanBlock["sets"][number]) {
  const min = s.reps_min ?? s.reps ?? null;
  const max = s.reps_max ?? s.reps ?? null;
  if (min != null && max != null && min > max) throw badRequest("reps_min must be <= reps_max");
  db.query(
    `INSERT INTO sets (workout_exercise_id, set_number, type, is_planned, target_reps_min, target_reps_max,
       target_weight_kg, target_rpe, target_duration_s, target_distance_m, notes)
     VALUES ($block, $n, $type, 1, $min, $max, $w, $rpe, $dur, $dist, $notes)`,
  ).run({
    block: blockId,
    n: nextSetNumber(db, blockId),
    type: s.type ?? "normal",
    min,
    max,
    w: s.weight_kg ?? null,
    rpe: s.rpe ?? null,
    dur: s.duration_s ?? null,
    dist: s.distance_m ?? null,
    notes: s.notes ?? null,
  });
}

/** Live logging stamps performed_at; backfills (another day) leave it null so they don't fake timings. */
function performedAtFor(ctx: Ctx, date: string, explicitTimes: boolean) {
  return !explicitTimes && date === today(ctx) ? nowIso(ctx) : null;
}

function getSetRow(db: DB, id: number): SetRow {
  const s = db.query<SetRow, [number]>("SELECT * FROM sets WHERE id = ?").get(id);
  if (!s) throw notFound(`Set ${id}`);
  return s;
}

function setContext(db: DB, setId: number) {
  return db
    .query<
      { workout_id: number; date: string; exercise_id: string; exercise_name: string; exercise_type: string; block_id: number },
      [number]
    >(
      `SELECT w.id AS workout_id, w.date, we.exercise_id, e.name AS exercise_name, e.type AS exercise_type, we.id AS block_id
       FROM sets s JOIN workout_exercises we ON we.id = s.workout_exercise_id
       JOIN workouts w ON w.id = we.workout_id JOIN exercises e ON e.id = we.exercise_id
       WHERE s.id = ?`,
    )
    .get(setId)!;
}

/** The result every set write returns: the set, where it lives, PR flags and what's next in the plan. */
function setResult(ctx: Ctx, setId: number, extra: { filled_planned?: boolean } = {}) {
  const { db } = ctx;
  const s = getSetRow(db, setId);
  const where = setContext(db, setId);
  const nextPlanned = db
    .query<SetRow, [number]>("SELECT * FROM sets WHERE workout_exercise_id = ? AND is_planned = 1 ORDER BY set_number LIMIT 1")
    .get(where.block_id);
  const remaining = db
    .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM sets WHERE workout_exercise_id = ? AND is_planned = 1")
    .get(where.block_id)!.n;
  const pr: PrFlags = s.is_planned ? { heaviest: false, e1rm: false, reps_at_weight: false } : prFlags(db, setId);
  return {
    set: toSet(s),
    workout_id: where.workout_id,
    date: where.date,
    exercise: { id: where.exercise_id, name: where.exercise_name, type: where.exercise_type },
    ...extra,
    pr,
    is_pr: anyPr(pr),
    planned_remaining: remaining,
    next_planned: nextPlanned ? toSet(nextPlanned) : null,
    warnings: s.is_planned ? [] : typeWarnings(where.exercise_type, s),
  };
}
export type SetResult = ReturnType<typeof setResult>;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** The common path: log one set. With no workout/date it goes to today's workout, creating it if needed. */
export function logSet(ctx: Ctx, input: LogSetInput): SetResult {
  const { db } = ctx;
  assertMeasured(input);
  requireExercise(db, input.exercise_id);
  let date = input.date ?? today(ctx);
  if (input.workout_id != null) {
    const w = requireWorkout(db, input.workout_id);
    if (input.date && input.date !== w.date) throw badRequest("workout_id and date disagree", { workout_date: w.date });
    date = w.date;
  }
  const { id, filled_planned } = db.transaction(() => {
    const w = ensureWorkout(db, date);
    const block = ensureBlock(db, w.id, input.exercise_id);
    return recordPerformedSet(db, block.id, input, performedAtFor(ctx, date, false));
  })();
  return setResult(ctx, id, { filled_planned });
}

/** Log a whole session at once (merged into that day's workout if one exists). */
export function logWorkout(ctx: Ctx, input: LogWorkoutInput) {
  const { db } = ctx;
  for (const b of input.exercises) {
    requireExercise(db, b.exercise_id);
    b.sets.forEach(assertMeasured);
  }
  const date = input.date ?? today(ctx);
  const explicit = input.start_time != null || input.end_time != null;
  const at = performedAtFor(ctx, date, explicit);
  const { workoutId, setIds } = db.transaction(() => {
    const w = ensureWorkout(db, date, input);
    const ids: number[] = [];
    for (const b of input.exercises) {
      const block = ensureBlock(db, w.id, b.exercise_id, b);
      for (const s of b.sets) ids.push(recordPerformedSet(db, block.id, s, at).id);
    }
    return { workoutId: w.id, setIds: ids };
  })();
  return { workout: getWorkout(ctx, workoutId), prs: collectPrs(ctx, setIds) };
}

function collectPrs(ctx: Ctx, setIds: number[]) {
  return setIds
    .map((id) => ({ set_id: id, flags: prFlags(ctx.db, id) }))
    .filter((p) => anyPr(p.flags))
    .map((p) => ({ ...p, exercise_id: setContext(ctx.db, p.set_id).exercise_id }));
}

/** Save target sets for a day (status derives to `planned` until something is performed). */
export function planSession(ctx: Ctx, input: PlanSessionInput, extra: { routine_id?: number } = {}): WorkoutDetail {
  const { db } = ctx;
  for (const b of input.exercises) requireExercise(db, b.exercise_id);
  const date = input.date ?? today(ctx);
  const workoutId = db.transaction(() => {
    const w = ensureWorkout(db, date, { name: input.name, notes: input.notes, routine_id: extra.routine_id });
    for (const b of input.exercises) {
      const block = ensureBlock(db, w.id, b.exercise_id, b);
      for (const s of b.sets) insertPlannedSet(db, block.id, s);
    }
    return w.id;
  })();
  return getWorkout(ctx, workoutId);
}

/** Turn one specific planned set into a performed one. */
export function completePlannedSet(ctx: Ctx, input: CompletePlannedSetInput): SetResult {
  const { db } = ctx;
  const s = getSetRow(db, input.set_id);
  if (s.is_planned === 0) throw conflict(`Set ${s.id} is already performed; use update_set to change it`);
  assertMeasured(input);
  const where = setContext(db, s.id);
  db.query(
    `UPDATE sets SET is_planned = 0, type = COALESCE($type, type), reps = $reps, weight_kg = $weight_kg,
       duration_s = $duration_s, distance_m = $distance_m, rpe = $rpe, notes = COALESCE($notes, notes), performed_at = $at
     WHERE id = $id`,
  ).run({
    id: s.id,
    type: input.type ?? null,
    reps: input.reps ?? null,
    weight_kg: input.weight_kg ?? null,
    duration_s: input.duration_s ?? null,
    distance_m: input.distance_m ?? null,
    rpe: input.rpe ?? null,
    notes: input.notes ?? null,
    at: performedAtFor(ctx, where.date, false),
  });
  return setResult(ctx, s.id, { filled_planned: true });
}

export function updateSet(ctx: Ctx, id: number, patch: SetPatch): SetResult {
  const { db } = ctx;
  getSetRow(db, id);
  const keys = Object.keys(patch).filter((k) => patch[k as keyof SetPatch] !== undefined) as (keyof SetPatch)[];
  if (keys.length === 0) throw badRequest("Nothing to update");
  const params: Record<string, string | number | null> = { id };
  for (const k of keys) params[k] = patch[k] as string | number | null;
  db.query(`UPDATE sets SET ${keys.map((k) => `${k} = $${k}`).join(", ")} WHERE id = $id`).run(params);
  return setResult(ctx, id);
}

/** Delete a set, renumber the rest of its block, and drop the block if it's now empty. */
export function deleteSet(ctx: Ctx, id: number) {
  const { db } = ctx;
  const s = getSetRow(db, id);
  const where = setContext(db, id);
  db.transaction(() => {
    db.query("DELETE FROM sets WHERE id = ?").run(id);
    const rest = db
      .query<{ id: number }, [number]>("SELECT id FROM sets WHERE workout_exercise_id = ? ORDER BY set_number, id")
      .all(s.workout_exercise_id);
    const renumber = db.query("UPDATE sets SET set_number = ? WHERE id = ?");
    rest.forEach((r, i) => renumber.run(i + 1, r.id));
    if (rest.length === 0) {
      db.query("DELETE FROM workout_exercises WHERE id = ?").run(s.workout_exercise_id);
      compactPositions(db, where.workout_id);
    }
  })();
  return { deleted: true, set_id: id, workout_id: where.workout_id };
}

function compactPositions(db: DB, workoutId: number) {
  const blocks = db
    .query<{ id: number }, [number]>("SELECT id FROM workout_exercises WHERE workout_id = ? ORDER BY position, id")
    .all(workoutId);
  const upd = db.query("UPDATE workout_exercises SET position = ? WHERE id = ?");
  blocks.forEach((b, i) => upd.run(i + 1, b.id));
}

export function updateWorkout(ctx: Ctx, id: number, patch: WorkoutPatch): WorkoutDetail {
  const { db } = ctx;
  requireWorkout(db, id);
  const keys = Object.keys(patch).filter((k) => patch[k as keyof WorkoutPatch] !== undefined) as (keyof WorkoutPatch)[];
  if (keys.length === 0) throw badRequest("Nothing to update");
  if (patch.date) {
    const clash = db.query<{ id: number }, [string, number]>("SELECT id FROM workouts WHERE date = ? AND id != ?").get(patch.date, id);
    if (clash) throw conflict(`There is already a workout on ${patch.date}`, { workout_id: clash.id });
  }
  const params: Record<string, string | number | null> = { id };
  for (const k of keys) {
    const v = patch[k] ?? null;
    params[k] = v && (k === "start_time" || k === "end_time") ? new Date(v).toISOString() : v;
  }
  db.query(`UPDATE workouts SET ${keys.map((k) => `${k} = $${k}`).join(", ")} WHERE id = $id`).run(params);
  return getWorkout(ctx, id);
}

export function deleteWorkout(ctx: Ctx, id: number) {
  requireWorkout(ctx.db, id);
  ctx.db.query("DELETE FROM workouts WHERE id = ?").run(id);
  return { deleted: true, workout_id: id };
}

/** Edit a block's notes/superset/rest, or move it to another position (others shift to make room). */
export function updateBlock(ctx: Ctx, blockId: number, patch: BlockPatch): WorkoutDetail {
  const { db } = ctx;
  const b = db.query<BlockRow, [number]>("SELECT * FROM workout_exercises WHERE id = ?").get(blockId);
  if (!b) throw notFound(`Workout exercise ${blockId}`);
  const { position, ...rest } = patch;
  const keys = Object.keys(rest).filter((k) => rest[k as keyof typeof rest] !== undefined) as (keyof typeof rest)[];
  if (keys.length === 0 && position == null) throw badRequest("Nothing to update");
  db.transaction(() => {
    if (keys.length) {
      const params: Record<string, string | number | null> = { id: blockId };
      for (const k of keys) params[k] = rest[k] ?? null;
      db.query(`UPDATE workout_exercises SET ${keys.map((k) => `${k} = $${k}`).join(", ")} WHERE id = $id`).run(params);
    }
    if (position != null) {
      const ids = db
        .query<{ id: number }, [number]>("SELECT id FROM workout_exercises WHERE workout_id = ? ORDER BY position, id")
        .all(b.workout_id)
        .map((r) => r.id)
        .filter((i) => i !== blockId);
      ids.splice(Math.min(position, ids.length + 1) - 1, 0, blockId);
      const upd = db.query("UPDATE workout_exercises SET position = ? WHERE id = ?");
      ids.forEach((i, idx) => upd.run(idx + 1, i));
    }
  })();
  return getWorkout(ctx, b.workout_id);
}
