import type { Ctx } from "../app.ts";
import type { DB } from "../db.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import type { CycleTargetSet, PlanBlock, ProgramInput, ProgramPatch, SetCycleTargetsInput } from "../schemas.ts";
import { bodyweightOn, countsForStrength, effectiveLoad, epley, roundKg } from "./load.ts";
import { getRoutine } from "./routines.ts";
import { formatSet } from "./stats.ts";
import { getWorkout, planSession, today, type WorkoutDetail } from "./workouts.ts";

/**
 * Programs are an ordered list of routines run on repeat. One pass through the list is a cycle,
 * and each cycle owns a copy of its target sets so progression is recorded cycle by cycle.
 *
 * - The current cycle is the earliest one that isn't complete (a cycle Claude set up in advance
 *   never hides the one you're in the middle of).
 * - A slot is done once its workout has performed sets; started once it's planned on a day.
 * - Nothing happens automatically when a cycle completes: the next one is created on demand
 *   (start_next_workout carries targets over) or by set_cycle_targets.
 */

// ---------------------------------------------------------------------------
// Rows & lookups
// ---------------------------------------------------------------------------

type ProgramRow = { id: number; name: string; notes: string | null; is_active: number; created_at: string; updated_at: string };
type SlotRow = { id: number; position: number; routine_id: number; routine_name: string };
type CycleRow = { id: number; program_id: number; number: number; targets_source: string; notes: string | null; created_at: string; updated_at: string };
type CycleExerciseRow = {
  id: number;
  slot_id: number;
  exercise_id: string;
  position: number;
  superset_group: number | null;
  notes: string | null;
  rest_seconds: number | null;
  name: string;
  type: string;
};
type CycleSetRow = {
  cycle_exercise_id: number;
  set_number: number;
  type: string;
  reps_min: number | null;
  reps_max: number | null;
  weight_kg: number | null;
  rpe: number | null;
  duration_s: number | null;
  distance_m: number | null;
};

export type SlotStatus = "pending" | "started" | "done" | "skipped";

function requireProgram(db: DB, id: number): ProgramRow {
  const p = db.query<ProgramRow, [number]>("SELECT * FROM programs WHERE id = ?").get(id);
  if (!p) throw notFound(`Program ${id}`, { programs: db.query("SELECT id, name, is_active FROM programs ORDER BY name").all() });
  return p;
}

function activeProgram(db: DB): ProgramRow {
  const p = db.query<ProgramRow, []>("SELECT * FROM programs WHERE is_active = 1").get();
  if (!p) {
    throw notFound("Active program", {
      hint: "Create one with create_program, or activate an existing one with update_program",
      programs: db.query("SELECT id, name FROM programs ORDER BY name").all(),
    });
  }
  return p;
}

const slotsOf = (db: DB, programId: number) =>
  db
    .query<SlotRow, [number]>(
      `SELECT s.id, s.position, s.routine_id, r.name AS routine_name
       FROM program_slots s JOIN routines r ON r.id = s.routine_id
       WHERE s.program_id = ? ORDER BY s.position`,
    )
    .all(programId);

const cyclesOf = (db: DB, programId: number) =>
  db.query<CycleRow, [number]>("SELECT * FROM cycles WHERE program_id = ? ORDER BY number").all(programId);

/** The workout started for a slot in a cycle, with how many sets have been performed. */
function slotWorkout(db: DB, cycleId: number, slotId: number) {
  return db
    .query<{ id: number; date: string; performed: number }, [number, number]>(
      `SELECT w.id, w.date,
         (SELECT COUNT(*) FROM sets s JOIN workout_exercises we ON we.id = s.workout_exercise_id
          WHERE we.workout_id = w.id AND s.is_planned = 0) AS performed
       FROM workouts w WHERE w.cycle_id = ? AND w.slot_id = ?`,
    )
    .get(cycleId, slotId);
}

function slotStatus(db: DB, cycleId: number, slotId: number): { status: SlotStatus; workout: { id: number; date: string } | null } {
  const skipped = db.query("SELECT 1 FROM cycle_slot_skips WHERE cycle_id = ? AND slot_id = ?").get(cycleId, slotId);
  const w = slotWorkout(db, cycleId, slotId);
  const workout = w ? { id: w.id, date: w.date } : null;
  if (w && w.performed > 0) return { status: "done", workout };
  if (skipped) return { status: "skipped", workout };
  return { status: w ? "started" : "pending", workout };
}

const isComplete = (db: DB, cycle: CycleRow, slots: SlotRow[]) =>
  slots.every((s) => {
    const { status } = slotStatus(db, cycle.id, s.id);
    return status === "done" || status === "skipped";
  });

/** Earliest incomplete cycle, or null if every cycle is complete. */
function currentCycle(db: DB, programId: number): CycleRow | null {
  const slots = slotsOf(db, programId);
  return cyclesOf(db, programId).find((c) => !isComplete(db, c, slots)) ?? null;
}

// ---------------------------------------------------------------------------
// Building a cycle's targets
// ---------------------------------------------------------------------------

/**
 * Create cycle N+1. Each slot's exercises come from its routine as it is now (so routine edits take
 * effect here); an exercise the previous cycle also had keeps that cycle's full target sets (so sets
 * Claude added survive), otherwise the routine's defaults are used.
 */
function createCycle(ctx: Ctx, programId: number, source: "initial" | "carried_over"): CycleRow {
  const { db } = ctx;
  const cycles = cyclesOf(db, programId);
  const prev = cycles[cycles.length - 1] ?? null;
  const number = (prev?.number ?? 0) + 1;
  const cycleId = Number(
    db.query("INSERT INTO cycles (program_id, number, targets_source) VALUES (?, ?, ?)").run(programId, number, source).lastInsertRowid,
  );
  const insEx = db.query(
    `INSERT INTO cycle_exercises (cycle_id, slot_id, exercise_id, position, superset_group, notes, rest_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const prevEx = db.query<{ id: number }, [number, number, string]>(
    "SELECT id FROM cycle_exercises WHERE cycle_id = ? AND slot_id = ? AND exercise_id = ?",
  );
  const prevSets = db.query<CycleSetRow, [number]>("SELECT * FROM cycle_sets WHERE cycle_exercise_id = ? ORDER BY set_number");
  for (const slot of slotsOf(db, programId)) {
    const routine = getRoutine(ctx, slot.routine_id);
    routine.exercises.forEach((b, i) => {
      const ceId = Number(
        insEx.run(cycleId, slot.id, b.exercise.id, i + 1, b.superset_group, b.notes, b.rest_seconds).lastInsertRowid,
      );
      const carried = prev ? prevEx.get(prev.id, slot.id, b.exercise.id) : null;
      const sets: CycleTargetSet[] = carried
        ? prevSets.all(carried.id).map((s) => nullsToUndefined(s))
        : b.sets.map((s) => nullsToUndefined(s));
      insertCycleSets(db, ceId, sets);
    });
  }
  return db.query<CycleRow, [number]>("SELECT * FROM cycles WHERE id = ?").get(cycleId)!;
}

function nullsToUndefined(s: {
  type: string;
  reps_min: number | null;
  reps_max: number | null;
  weight_kg: number | null;
  rpe: number | null;
  duration_s: number | null;
  distance_m: number | null;
}): CycleTargetSet {
  return {
    type: s.type as CycleTargetSet["type"],
    reps_min: s.reps_min ?? undefined,
    reps_max: s.reps_max ?? undefined,
    weight_kg: s.weight_kg ?? undefined,
    rpe: s.rpe ?? undefined,
    duration_s: s.duration_s ?? undefined,
    distance_m: s.distance_m ?? undefined,
  };
}

function insertCycleSets(db: DB, cycleExerciseId: number, sets: CycleTargetSet[]) {
  const ins = db.query(
    `INSERT INTO cycle_sets (cycle_exercise_id, set_number, type, reps_min, reps_max, weight_kg, rpe, duration_s, distance_m)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  sets.forEach((s, i) => {
    const min = s.reps_min ?? s.reps ?? null;
    const max = s.reps_max ?? s.reps ?? null;
    if (min != null && max != null && min > max) throw badRequest("reps_min must be <= reps_max");
    ins.run(cycleExerciseId, i + 1, s.type ?? "normal", min, max, s.weight_kg ?? null, s.rpe ?? null, s.duration_s ?? null, s.distance_m ?? null);
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function slotTargets(db: DB, cycleId: number, slotId: number) {
  const exercises = db
    .query<CycleExerciseRow, [number, number]>(
      `SELECT ce.*, e.name, e.type FROM cycle_exercises ce JOIN exercises e ON e.id = ce.exercise_id
       WHERE ce.cycle_id = ? AND ce.slot_id = ? ORDER BY ce.position`,
    )
    .all(cycleId, slotId);
  const setsQ = db.query<CycleSetRow, [number]>("SELECT * FROM cycle_sets WHERE cycle_exercise_id = ? ORDER BY set_number");
  return exercises.map((e) => ({
    exercise: { id: e.exercise_id, name: e.name, type: e.type },
    position: e.position,
    superset_group: e.superset_group,
    notes: e.notes,
    rest_seconds: e.rest_seconds,
    sets: setsQ.all(e.id).map((s) => ({
      set_number: s.set_number,
      type: s.type,
      reps_min: s.reps_min,
      reps_max: s.reps_max,
      weight_kg: roundKg(s.weight_kg),
      rpe: s.rpe,
      duration_s: s.duration_s,
      distance_m: s.distance_m,
    })),
  }));
}
type SlotTargets = ReturnType<typeof slotTargets>;

function cycleDetail(db: DB, cycle: CycleRow, slots: SlotRow[]) {
  const slotOut = slots.map((s) => ({
    position: s.position,
    routine: { id: s.routine_id, name: s.routine_name },
    ...slotStatus(db, cycle.id, s.id),
    exercises: slotTargets(db, cycle.id, s.id),
  }));
  const next = slotOut.find((s) => s.status === "pending" || s.status === "started");
  return {
    number: cycle.number,
    targets_source: cycle.targets_source,
    notes: cycle.notes,
    complete: !next,
    next_slot_position: next?.position ?? null,
    slots: slotOut,
    created_at: cycle.created_at,
    updated_at: cycle.updated_at,
  };
}
export type CycleDetail = ReturnType<typeof cycleDetail>;

/** One-line target, e.g. "80×5-8, 80×5-8, 82.5×5". */
export function describeTargets(sets: SlotTargets[number]["sets"]): string {
  return sets
    .map((s) => {
      const reps = s.reps_min === s.reps_max ? `${s.reps_min ?? "?"}` : `${s.reps_min ?? "?"}-${s.reps_max ?? "?"}`;
      const core = s.weight_kg != null ? `${s.weight_kg}×${reps}` : s.duration_s != null ? `${s.duration_s}s` : `×${reps}`;
      return `${s.type === "warmup" ? "(w) " : ""}${core}${s.rpe != null ? ` @${s.rpe}` : ""}`;
    })
    .join(", ");
}

export function getProgram(ctx: Ctx, id?: number) {
  const { db } = ctx;
  const p = id != null ? requireProgram(db, id) : activeProgram(db);
  const slots = slotsOf(db, p.id);
  const cycles = cyclesOf(db, p.id);
  const current = currentCycle(db, p.id) ?? cycles[cycles.length - 1]!;
  return {
    id: p.id,
    name: p.name,
    notes: p.notes,
    is_active: p.is_active === 1,
    slots: slots.map((s) => ({ position: s.position, routine: { id: s.routine_id, name: s.routine_name } })),
    cycles_completed: cycles.filter((c) => isComplete(db, c, slots)).length,
    current_cycle: cycleDetail(db, current, slots),
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}
export type ProgramDetail = ReturnType<typeof getProgram>;

export function listPrograms(ctx: Ctx) {
  const { db } = ctx;
  return db
    .query<ProgramRow, []>("SELECT * FROM programs ORDER BY is_active DESC, name")
    .all()
    .map((p) => {
      const slots = slotsOf(db, p.id);
      const cycles = cyclesOf(db, p.id);
      const current = currentCycle(db, p.id);
      return {
        id: p.id,
        name: p.name,
        is_active: p.is_active === 1,
        routines: slots.map((s) => s.routine_name),
        current_cycle: current?.number ?? cycles[cycles.length - 1]?.number ?? null,
        cycles_completed: cycles.filter((c) => isComplete(db, c, slots)).length,
      };
    });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function insertSlots(ctx: Ctx, programId: number, routineIds: number[]) {
  const ins = ctx.db.query("INSERT INTO program_slots (program_id, position, routine_id) VALUES (?, ?, ?)");
  routineIds.forEach((rid, i) => ins.run(programId, i + 1, rid));
}

function assertNameFree(db: DB, name: string, exceptId = 0) {
  const clash = db.query<{ id: number }, [string, number]>("SELECT id FROM programs WHERE lower(name) = lower(?) AND id != ?").get(name, exceptId);
  if (clash) throw conflict(`A program called '${name}' already exists`, { program_id: clash.id });
}

export function createProgram(ctx: Ctx, input: ProgramInput): ProgramDetail {
  const { db } = ctx;
  assertNameFree(db, input.name);
  for (const rid of input.routine_ids) getRoutine(ctx, rid); // 404s with the routine list
  const id = db.transaction(() => {
    if (input.activate) db.run("UPDATE programs SET is_active = 0 WHERE is_active = 1");
    const id = Number(
      db
        .query("INSERT INTO programs (name, notes, is_active) VALUES (?, ?, ?)")
        .run(input.name, input.notes ?? null, input.activate ? 1 : 0).lastInsertRowid,
    );
    insertSlots(ctx, id, input.routine_ids);
    createCycle(ctx, id, "initial");
    return id;
  })();
  return getProgram(ctx, id);
}

export function updateProgram(ctx: Ctx, id: number, patch: ProgramPatch): ProgramDetail {
  const { db } = ctx;
  requireProgram(db, id);
  if (Object.values(patch).every((v) => v === undefined)) throw badRequest("Nothing to update");
  if (patch.name) assertNameFree(db, patch.name, id);
  if (patch.routine_ids) {
    const started = db
      .query("SELECT 1 FROM workouts w JOIN cycles c ON c.id = w.cycle_id WHERE c.program_id = ? LIMIT 1")
      .get(id);
    if (started) throw conflict("This program has started workouts; create a new program to change its routines");
    for (const rid of patch.routine_ids) getRoutine(ctx, rid);
  }
  db.transaction(() => {
    if (patch.name !== undefined) db.query("UPDATE programs SET name = ? WHERE id = ?").run(patch.name, id);
    if (patch.notes !== undefined) db.query("UPDATE programs SET notes = ? WHERE id = ?").run(patch.notes, id);
    if (patch.routine_ids) {
      db.query("DELETE FROM cycles WHERE program_id = ?").run(id);
      db.query("DELETE FROM program_slots WHERE program_id = ?").run(id);
      insertSlots(ctx, id, patch.routine_ids);
      createCycle(ctx, id, "initial");
    }
    if (patch.active === true) {
      db.query("UPDATE programs SET is_active = 0 WHERE is_active = 1 AND id != ?").run(id);
      db.query("UPDATE programs SET is_active = 1 WHERE id = ?").run(id);
    } else if (patch.active === false) {
      db.query("UPDATE programs SET is_active = 0 WHERE id = ?").run(id);
    }
  })();
  return getProgram(ctx, id);
}

export type NextWorkoutResult = {
  program: { id: number; name: string };
  cycle: { number: number; targets_source: string };
  slot: { position: number; of: number; routine: { id: number; name: string } };
  already_started: boolean;
  workout: WorkoutDetail;
};

/**
 * Plan the next slot of the current cycle onto a day (default today). If the current cycle is
 * complete, the next one is created first with targets carried over. A slot already planned on a
 * day is returned rather than planned twice.
 */
export function startNextWorkout(ctx: Ctx, input: { date?: string } = {}): NextWorkoutResult {
  const { db } = ctx;
  const program = activeProgram(db);
  const slots = slotsOf(db, program.id);
  return db.transaction(() => {
    const cycle = currentCycle(db, program.id) ?? createCycle(ctx, program.id, "carried_over");
    const statuses = slots.map((s) => ({ slot: s, ...slotStatus(db, cycle.id, s.id) }));
    const next = statuses.find((s) => s.status === "pending" || s.status === "started")!;
    const base = {
      program: { id: program.id, name: program.name },
      cycle: { number: cycle.number, targets_source: cycle.targets_source },
      slot: { position: next.slot.position, of: slots.length, routine: { id: next.slot.routine_id, name: next.slot.routine_name } },
    };
    if (next.status === "started") {
      return { ...base, already_started: true, workout: getWorkout(ctx, next.workout!.id) };
    }
    const date = input.date ?? today(ctx);
    const existing = db
      .query<{ id: number; cycle_id: number | null; slot_id: number | null }, [string]>(
        "SELECT id, cycle_id, slot_id FROM workouts WHERE date = ?",
      )
      .get(date);
    if (existing?.slot_id != null) {
      throw conflict(`${date} already has a program workout; plan this one on another date`, { workout_id: existing.id });
    }
    const targets = slotTargets(db, cycle.id, next.slot.id);
    const routine = getRoutine(ctx, next.slot.routine_id);
    const exercises: PlanBlock[] = targets.map((t) => ({
      exercise_id: t.exercise.id,
      superset_group: t.superset_group ?? undefined,
      notes: t.notes ?? undefined,
      rest_seconds: t.rest_seconds ?? undefined,
      sets: t.sets.map((s) => ({
        type: s.type as PlanBlock["sets"][number]["type"],
        reps_min: s.reps_min ?? undefined,
        reps_max: s.reps_max ?? undefined,
        weight_kg: s.weight_kg ?? undefined,
        rpe: s.rpe ?? undefined,
        duration_s: s.duration_s ?? undefined,
        distance_m: s.distance_m ?? undefined,
      })),
    }));
    const planned = planSession(ctx, { date, name: routine.name, notes: routine.notes ?? undefined, exercises }, { routine_id: routine.id });
    db.query("UPDATE workouts SET cycle_id = ?, slot_id = ? WHERE id = ?").run(cycle.id, next.slot.id, planned.id);
    return { ...base, already_started: false, workout: getWorkout(ctx, planned.id) };
  })();
}

/** Skip a slot of the current cycle (default: the next one due) so the cycle can move on. */
export function skipSlot(ctx: Ctx, input: { slot_position?: number } = {}) {
  const { db } = ctx;
  const program = activeProgram(db);
  const slots = slotsOf(db, program.id);
  const cycle = currentCycle(db, program.id);
  if (!cycle) throw conflict("The current cycle is complete; start the next workout to begin a new cycle");
  const statuses = slots.map((s) => ({ slot: s, ...slotStatus(db, cycle.id, s.id) }));
  const target =
    input.slot_position != null
      ? statuses.find((s) => s.slot.position === input.slot_position)
      : statuses.find((s) => s.status === "pending" || s.status === "started");
  if (!target) throw notFound(`Slot ${input.slot_position}`, { slots: slots.map((s) => ({ position: s.position, routine: s.routine_name })) });
  if (target.status === "done") throw conflict(`Slot ${target.slot.position} (${target.slot.routine_name}) is already done`);
  db.query("INSERT OR IGNORE INTO cycle_slot_skips (cycle_id, slot_id) VALUES (?, ?)").run(cycle.id, target.slot.id);
  return {
    skipped: { position: target.slot.position, routine: target.slot.routine_name },
    cycle: cycleDetail(db, cycle, slots),
  };
}

/**
 * Set targets for a cycle (default: the latest cycle if it's unfinished, otherwise a new next cycle).
 * Partial: only listed exercises change; each listed exercise's sets are replaced. Slots whose
 * workout has started are locked.
 */
export function setCycleTargets(ctx: Ctx, input: SetCycleTargetsInput) {
  const { db } = ctx;
  const program = activeProgram(db);
  const slots = slotsOf(db, program.id);
  return db.transaction(() => {
    const cycles = cyclesOf(db, program.id);
    const latest = cycles[cycles.length - 1]!;
    let cycle: CycleRow;
    if (input.cycle_number != null) {
      const found = cycles.find((c) => c.number === input.cycle_number);
      if (found) cycle = found;
      else if (input.cycle_number === latest.number + 1) cycle = createCycle(ctx, program.id, "carried_over");
      else throw notFound(`Cycle ${input.cycle_number}`, { cycles: cycles.map((c) => c.number), next: latest.number + 1 });
    } else {
      cycle = isComplete(db, latest, slots) ? createCycle(ctx, program.id, "carried_over") : latest;
    }

    for (const s of input.slots) {
      const slot = slots.find((x) => x.position === s.slot_position);
      if (!slot) throw badRequest(`No slot ${s.slot_position}`, { slots: slots.map((x) => ({ position: x.position, routine: x.routine_name })) });
      const { status } = slotStatus(db, cycle.id, slot.id);
      if (status === "started" || status === "done") {
        throw conflict(`Cycle ${cycle.number} slot ${slot.position} (${slot.routine_name}) has started; its targets are locked`);
      }
      for (const e of s.exercises) {
        const ce = db
          .query<{ id: number }, [number, number, string]>(
            "SELECT id FROM cycle_exercises WHERE cycle_id = ? AND slot_id = ? AND exercise_id = ?",
          )
          .get(cycle.id, slot.id, e.exercise_id);
        if (!ce) {
          throw badRequest(`'${e.exercise_id}' isn't in ${slot.routine_name}; edit the routine to change exercises`, {
            exercises: slotTargets(db, cycle.id, slot.id).map((t) => t.exercise.id),
          });
        }
        db.query("DELETE FROM cycle_sets WHERE cycle_exercise_id = ?").run(ce.id);
        insertCycleSets(db, ce.id, e.sets);
      }
    }
    db.query("UPDATE cycles SET targets_source = 'claude', notes = COALESCE(?, notes) WHERE id = ?").run(input.notes ?? null, cycle.id);
    const updated = db.query<CycleRow, [number]>("SELECT * FROM cycles WHERE id = ?").get(cycle.id)!;
    return { program: { id: program.id, name: program.name }, cycle: cycleDetail(db, updated, slots) };
  })();
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

type ActualSet = { set_number: number; type: string; reps: number | null; weight_kg: number | null; rpe: number | null; duration_s: number | null; distance_m: number | null; is_planned: number };

function actualSets(db: DB, workoutId: number, exerciseId: string): ActualSet[] {
  return db
    .query<ActualSet, [number, string]>(
      `SELECT s.set_number, s.type, s.reps, s.weight_kg, s.rpe, s.duration_s, s.distance_m, s.is_planned
       FROM sets s JOIN workout_exercises we ON we.id = s.workout_exercise_id
       WHERE we.workout_id = ? AND we.exercise_id = ? AND s.is_planned = 0 ORDER BY s.set_number`,
    )
    .all(workoutId, exerciseId);
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Best e1RM per exercise across a cycle's workouts. */
function cycleBestE1rm(db: DB, cycleId: number): Map<string, number> {
  const rows = db
    .query<ActualSet & { exercise_id: string; exercise_type: string; date: string }, [number]>(
      `SELECT s.set_number, s.type, s.reps, s.weight_kg, s.rpe, s.duration_s, s.distance_m, s.is_planned,
              we.exercise_id, e.type AS exercise_type, w.date
       FROM workouts w JOIN workout_exercises we ON we.workout_id = w.id
       JOIN sets s ON s.workout_exercise_id = we.id JOIN exercises e ON e.id = we.exercise_id
       WHERE w.cycle_id = ? AND s.is_planned = 0`,
    )
    .all(cycleId);
  const best = new Map<string, number>();
  for (const s of rows) {
    if (!countsForStrength(s)) continue;
    const load = effectiveLoad(s.exercise_type, s.weight_kg, bodyweightOn(db, s.date));
    if (load == null || load <= 0) continue;
    const e = epley(load, s.reps!);
    if (e > (best.get(s.exercise_id) ?? 0)) best.set(s.exercise_id, e);
  }
  return best;
}

/**
 * How a cycle went, per slot and lift: targets vs what was performed, so Claude can set the next
 * cycle's targets from real numbers. Defaults to the latest completed cycle.
 */
export function reviewCycle(ctx: Ctx, input: { cycle_number?: number } = {}) {
  const { db } = ctx;
  const program = activeProgram(db);
  const slots = slotsOf(db, program.id);
  const cycles = cyclesOf(db, program.id);
  const cycle =
    input.cycle_number != null
      ? cycles.find((c) => c.number === input.cycle_number)
      : [...cycles].reverse().find((c) => isComplete(db, c, slots));
  if (!cycle) {
    throw notFound(input.cycle_number != null ? `Cycle ${input.cycle_number}` : "Completed cycle", {
      cycles: cycles.map((c) => ({ number: c.number, complete: isComplete(db, c, slots) })),
    });
  }
  const prev = cycles.find((c) => c.number === cycle.number - 1);
  const prevBest = prev ? cycleBestE1rm(db, prev.id) : new Map<string, number>();
  const thisBest = cycleBestE1rm(db, cycle.id);

  const dates: string[] = [];
  const slotReviews = slots.map((slot) => {
    const { status, workout } = slotStatus(db, cycle.id, slot.id);
    if (workout && status === "done") dates.push(workout.date);
    const exercises = slotTargets(db, cycle.id, slot.id).map((t) => {
      const actual = workout && status === "done" ? actualSets(db, workout.id, t.exercise.id) : [];
      const workingTargets = t.sets.filter((s) => s.type !== "warmup");
      const byNumber = new Map(actual.map((a) => [a.set_number, a]));
      const meets = (target: (typeof workingTargets)[number], reps: number | null) => {
        const a = byNumber.get(target.set_number);
        if (!a || a.reps == null) return false;
        const weightOk = target.weight_kg == null || (a.weight_kg ?? 0) >= target.weight_kg - 1e-9;
        return weightOk && (reps == null || a.reps >= reps);
      };
      const setsHit = workingTargets.filter((ts) => meets(ts, ts.reps_min)).length;
      const topAll = workingTargets.length > 0 && workingTargets.every((ts) => ts.reps_max != null && meets(ts, ts.reps_max));
      const actualRpe = avg(actual.filter((a) => a.type !== "warmup" && a.rpe != null).map((a) => a.rpe!));
      const targetRpe = avg(workingTargets.filter((s) => s.rpe != null).map((s) => s.rpe!));
      const e1 = thisBest.get(t.exercise.id);
      const p1 = prevBest.get(t.exercise.id);
      const performed = actual.map((a) => formatSet({ ...a, exercise_type: t.exercise.type })).join(", ");
      const summary =
        `${t.exercise.name}: target ${describeTargets(t.sets)} → ${performed || "not performed"}` +
        ` (${setsHit}/${workingTargets.length} hit${topAll ? ", top of range on all" : ""})` +
        (actualRpe != null ? `, RPE ${actualRpe}${targetRpe != null ? ` vs ${targetRpe}` : ""}` : "") +
        (e1 != null ? `, e1RM ${r1(e1)}${p1 != null ? ` (${e1 - p1 >= 0 ? "+" : ""}${r1(e1 - p1)})` : ""}` : "");
      return {
        exercise: t.exercise,
        targets: t.sets,
        performed: actual.map((a) => ({ ...a, weight_kg: roundKg(a.weight_kg) })),
        working_target_sets: workingTargets.length,
        sets_hit: setsHit,
        top_of_range_all_sets: topAll,
        avg_rpe: actualRpe,
        target_rpe: targetRpe,
        best_e1rm_kg: e1 != null ? r1(e1) : null,
        prev_cycle_best_e1rm_kg: p1 != null ? r1(p1) : null,
        summary,
      };
    });
    return { position: slot.position, routine: slot.routine_name, status, date: workout?.date ?? null, exercises };
  });

  dates.sort();
  const from = dates[0] ?? null;
  const to = dates[dates.length - 1] ?? null;
  const bwStart = from ? bodyweightOn(db, from) : null;
  const bwEnd = to ? bodyweightOn(db, to) : null;
  const adhoc =
    from && to
      ? db
          .query<{ id: number; date: string; name: string | null }, [string, string]>(
            "SELECT id, date, name FROM workouts WHERE cycle_id IS NULL AND date >= ? AND date <= ? ORDER BY date",
          )
          .all(from, to)
      : [];
  const nextCycle = cycles.find((c) => c.number === cycle.number + 1);
  return {
    program: { id: program.id, name: program.name },
    cycle: { number: cycle.number, complete: isComplete(db, cycle, slots), targets_source: cycle.targets_source, notes: cycle.notes },
    window: { from, to },
    slots: slotReviews,
    bodyweight: { start_kg: bwStart, end_kg: bwEnd, change_kg: bwStart != null && bwEnd != null ? r1(bwEnd - bwStart) : null },
    adhoc_workouts: adhoc,
    next_cycle: nextCycle ? { number: nextCycle.number, targets_source: nextCycle.targets_source } : null,
  };
}
