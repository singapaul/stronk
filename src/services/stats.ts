import type { DB } from "../db.ts";
import { bodyweightLookup, countsForStrength, effectiveLoad, epley, isWorking, roundKg } from "./load.ts";
import type { Ctx } from "../app.ts";
import { addDays, trainingDay } from "./dates.ts";
import { requireExercise } from "./exercises.ts";

/** A performed set with what stats need: its date and the exercise type. */
export type StatSet = {
  id: number;
  date: string;
  workout_id: number;
  exercise_id: string;
  exercise_type: string;
  type: string;
  reps: number | null;
  weight_kg: number | null;
  duration_s: number | null;
  distance_m: number | null;
  rpe: number | null;
  is_planned: number;
  set_number: number;
  load: number | null;
};

const STAT_SET_SQL = `
  SELECT s.id, w.date, w.id AS workout_id, we.exercise_id, e.type AS exercise_type, s.type, s.reps, s.weight_kg,
         s.duration_s, s.distance_m, s.rpe, s.is_planned, s.set_number
  FROM sets s
  JOIN workout_exercises we ON we.id = s.workout_exercise_id
  JOIN workouts w ON w.id = we.workout_id
  JOIN exercises e ON e.id = we.exercise_id`;

/** Performed sets for an exercise (optionally date-bounded), oldest first, with effective load resolved. */
export function performedSets(db: DB, exerciseId: string | null, opts: { from?: string; to?: string } = {}): StatSet[] {
  const rows = db
    .query<Omit<StatSet, "load">, { ex: string | null; from: string; to: string }>(
      `${STAT_SET_SQL}
       WHERE ($ex IS NULL OR we.exercise_id = $ex) AND s.is_planned = 0 AND w.date >= $from AND w.date <= $to
       ORDER BY w.date, we.position, s.set_number, s.id`,
    )
    .all({ ex: exerciseId, from: opts.from ?? "0000-00-00", to: opts.to ?? "9999-99-99" });
  const bw = bodyweightLookup(db);
  return rows.map((r) => ({ ...r, load: effectiveLoad(r.exercise_type, r.weight_kg, bw(r.date)) }));
}

export type PrFlags = { heaviest: boolean; e1rm: boolean; reps_at_weight: boolean };
const NO_PR: PrFlags = { heaviest: false, e1rm: false, reps_at_weight: false };

/**
 * Compare one performed set with every earlier working set of the same exercise ("earlier" = an earlier
 * day, or the same day with a lower id). A first-ever set isn't a PR: there's nothing to beat.
 */
export function prFlags(db: DB, setId: number): PrFlags {
  const row = db
    .query<{ exercise_id: string }, [number]>(
      "SELECT we.exercise_id FROM sets s JOIN workout_exercises we ON we.id = s.workout_exercise_id WHERE s.id = ?",
    )
    .get(setId);
  if (!row) return NO_PR;
  const all = performedSets(db, row.exercise_id);
  const me = all.find((s) => s.id === setId);
  if (!me || !countsForStrength(me) || me.load == null || me.load <= 0) return NO_PR;
  const prior = all.filter(
    (s) => s.id !== me.id && (s.date < me.date || (s.date === me.date && s.id < me.id)) && countsForStrength(s) && s.load != null && s.load > 0,
  );
  if (prior.length === 0) return NO_PR;
  const load = me.load;
  const reps = me.reps!;
  const maxLoad = Math.max(...prior.map((s) => s.load!));
  const maxE1rm = Math.max(...prior.map((s) => epley(s.load!, s.reps!)));
  const atOrAbove = prior.filter((s) => s.load! >= load);
  return {
    heaviest: load > maxLoad,
    e1rm: epley(load, reps) > maxE1rm + 1e-9,
    reps_at_weight: atOrAbove.length > 0 && reps > Math.max(...atOrAbove.map((s) => s.reps!)),
  };
}

export const anyPr = (f: PrFlags) => f.heaviest || f.e1rm || f.reps_at_weight;


// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Compact human form for Claude and summaries: "80×5 @8", "BW+20×5", "60s", "400m/95s", "(w) 40×10". */
export function formatSet(s: Pick<StatSet, "exercise_type" | "type" | "reps" | "weight_kg" | "duration_s" | "distance_m" | "rpe">): string {
  const tag = s.type === "warmup" ? "(w) " : s.type === "dropset" ? "(d) " : s.type === "failure" ? "(f) " : "";
  const w = roundKg(s.weight_kg);
  let core: string;
  if (s.exercise_type === "bodyweight_reps" || s.exercise_type === "bodyweight_assisted_reps") {
    const add = w ? (w > 0 ? `+${w}` : `${w}`) : "";
    core = `BW${add}×${s.reps ?? "?"}`;
  } else if (s.reps != null) {
    core = w != null ? `${w}×${s.reps}` : `${s.reps} reps`;
  } else {
    const parts = [w != null ? `${w}kg` : null, s.distance_m != null ? `${s.distance_m}m` : null, s.duration_s != null ? `${s.duration_s}s` : null];
    core = parts.filter(Boolean).join("/") || "?";
  }
  return `${tag}${core}${s.rpe != null ? ` @${s.rpe}` : ""}`;
}

const topSetOf = (sets: StatSet[]) =>
  sets
    .filter((s) => countsForStrength(s) && s.load != null && s.load > 0)
    .sort((a, b) => b.load! - a.load! || b.reps! - a.reps!)[0] ?? null;

function sessionStats(sets: StatSet[]) {
  const working = sets.filter(isWorking);
  const volume = working.reduce((acc, s) => acc + (s.load != null && s.load > 0 ? s.load * s.reps! : 0), 0);
  const top = topSetOf(sets);
  const strength = sets.filter((s) => countsForStrength(s) && s.load != null && s.load > 0);
  const e1rm = strength.length ? Math.max(...strength.map((s) => epley(s.load!, s.reps!))) : null;
  const durations = sets.filter((s) => s.type !== "warmup" && s.duration_s != null).map((s) => s.duration_s!);
  const distance = sets.filter((s) => s.type !== "warmup").reduce((a, s) => a + (s.distance_m ?? 0), 0);
  return {
    working_sets: working.length,
    total_reps: working.reduce((a, s) => a + (s.reps ?? 0), 0),
    volume_kg: Math.round(volume),
    top_set: top ? { load_kg: roundKg(top.load), reps: top.reps, rpe: top.rpe, text: formatSet(top) } : null,
    e1rm_kg: e1rm != null ? r1(e1rm) : null,
    ...(durations.length ? { longest_duration_s: Math.max(...durations) } : {}),
    ...(distance > 0 ? { total_distance_m: distance } : {}),
  };
}

const setOut = (s: StatSet) => ({
  set_id: s.id,
  set_number: s.set_number,
  type: s.type,
  reps: s.reps,
  weight_kg: roundKg(s.weight_kg),
  load_kg: roundKg(s.load),
  duration_s: s.duration_s,
  distance_m: s.distance_m,
  rpe: s.rpe,
  text: formatSet(s),
});

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const i of items) {
    const list = m.get(key(i)) ?? [];
    list.push(i);
    m.set(key(i), list);
  }
  return m;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export type HistoryInput = { limit?: number; from?: string; to?: string; format?: "sessions" | "sets" };

/** Recent performance on one exercise: per session (default) or a flat list of sets. Newest first. */
export function exerciseHistory(ctx: Ctx, exerciseId: string, input: HistoryInput = {}) {
  const ex = requireExercise(ctx.db, exerciseId);
  const all = performedSets(ctx.db, exerciseId, input);
  const exercise = { id: ex.id, name: ex.name, type: ex.type };
  if (input.format === "sets") {
    const limit = input.limit ?? 50;
    return { exercise, sets: all.reverse().slice(0, limit).map((s) => ({ date: s.date, workout_id: s.workout_id, ...setOut(s) })) };
  }
  const limit = input.limit ?? 10;
  const byDate = [...groupBy(all, (s) => s.date).entries()].reverse().slice(0, limit);
  return {
    exercise,
    total_sessions: new Set(all.map((s) => s.date)).size,
    sessions: byDate.map(([date, sets]) => ({
      date,
      workout_id: sets[0]!.workout_id,
      summary: sets.map(formatSet).join(", "),
      ...sessionStats(sets),
      sets: sets.map(setOut),
    })),
  };
}

// ---------------------------------------------------------------------------
// PRs
// ---------------------------------------------------------------------------

function prsFor(sets: StatSet[]) {
  const strength = sets.filter((s) => countsForStrength(s) && s.load != null && s.load > 0);
  const result: Record<string, unknown> = {};
  if (strength.length) {
    const heaviest = [...strength].sort((a, b) => b.load! - a.load! || b.reps! - a.reps! || a.date.localeCompare(b.date))[0]!;
    const bestE1rm = [...strength].sort((a, b) => epley(b.load!, b.reps!) - epley(a.load!, a.reps!))[0]!;
    // Best reps at each load (rounded to 0.25 kg), heaviest first.
    const byLoad = new Map<number, StatSet>();
    for (const s of strength) {
      const k = roundKg(s.load)!;
      const cur = byLoad.get(k);
      if (!cur || s.reps! > cur.reps!) byLoad.set(k, s);
    }
    result.heaviest = { load_kg: roundKg(heaviest.load), reps: heaviest.reps, date: heaviest.date, set_id: heaviest.id };
    result.best_e1rm = {
      e1rm_kg: r1(epley(bestE1rm.load!, bestE1rm.reps!)),
      load_kg: roundKg(bestE1rm.load),
      reps: bestE1rm.reps,
      date: bestE1rm.date,
      set_id: bestE1rm.id,
    };
    result.best_reps_at_weight = [...byLoad.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([load, s]) => ({ load_kg: load, reps: s.reps, date: s.date }));
  }
  const timed = sets.filter((s) => s.type !== "warmup" && s.duration_s != null);
  if (timed.length) {
    const best = timed.reduce((a, b) => (b.duration_s! > a.duration_s! ? b : a));
    result.longest_duration = { duration_s: best.duration_s, date: best.date, set_id: best.id };
  }
  const far = sets.filter((s) => s.type !== "warmup" && s.distance_m != null);
  if (far.length) {
    const best = far.reduce((a, b) => (b.distance_m! > a.distance_m! ? b : a));
    result.longest_distance = { distance_m: best.distance_m, date: best.date, set_id: best.id };
  }
  return Object.keys(result).length ? result : null;
}

/** Personal records per exercise (or one exercise). */
export function personalRecords(ctx: Ctx, exerciseId?: string) {
  if (exerciseId) requireExercise(ctx.db, exerciseId);
  const sets = performedSets(ctx.db, exerciseId ?? null);
  const names = new Map(
    ctx.db.query<{ id: string; name: string }, []>("SELECT id, name FROM exercises WHERE id IN (SELECT exercise_id FROM workout_exercises)").all().map((r) => [r.id, r.name]),
  );
  const out: ({ exercise: { id: string; name: string; type: string } } & Record<string, unknown>)[] = [];
  for (const [id, list] of groupBy(sets, (s) => s.exercise_id)) {
    const prs = prsFor(list);
    if (prs) out.push({ exercise: { id, name: names.get(id) ?? id, type: list[0]!.exercise_type }, ...prs });
  }
  const e1 = (p: (typeof out)[number]) => (p.best_e1rm as { e1rm_kg: number } | undefined)?.e1rm_kg ?? 0;
  return { records: out.sort((a, b) => e1(b) - e1(a) || a.exercise.name.localeCompare(b.exercise.name)) };
}

// ---------------------------------------------------------------------------
// Summary & recent workouts
// ---------------------------------------------------------------------------

/** Sessions, volume and sets per muscle (primary = 1, secondary = 0.5) over a date range. Default: last 7 days. */
export function summary(ctx: Ctx, input: { from?: string; to?: string } = {}) {
  const to = input.to ?? trainingDay(ctx.clock());
  const from = input.from ?? addDays(to, -6);
  const sets = performedSets(ctx.db, null, { from, to });
  const working = sets.filter(isWorking);
  const muscles = new Map(
    ctx.db
      .query<{ id: string; name: string; primary_muscles: string; secondary_muscles: string }, []>(
        "SELECT id, name, primary_muscles, secondary_muscles FROM exercises WHERE id IN (SELECT exercise_id FROM workout_exercises)",
      )
      .all()
      .map((r) => [r.id, { name: r.name, primary: JSON.parse(r.primary_muscles) as string[], secondary: JSON.parse(r.secondary_muscles) as string[] }]),
  );
  const perMuscle = new Map<string, { primary_sets: number; weighted_sets: number }>();
  const bump = (m: string, p: number, w: number) => {
    const cur = perMuscle.get(m) ?? { primary_sets: 0, weighted_sets: 0 };
    cur.primary_sets += p;
    cur.weighted_sets += w;
    perMuscle.set(m, cur);
  };
  const perExercise = new Map<string, { sets: number; volume: number }>();
  let volume = 0;
  for (const s of working) {
    const info = muscles.get(s.exercise_id);
    for (const m of info?.primary ?? []) bump(m, 1, 1);
    for (const m of info?.secondary ?? []) bump(m, 0, 0.5);
    const v = s.load != null && s.load > 0 ? s.load * s.reps! : 0;
    volume += v;
    const e = perExercise.get(s.exercise_id) ?? { sets: 0, volume: 0 };
    e.sets++;
    e.volume += v;
    perExercise.set(s.exercise_id, e);
  }
  return {
    from,
    to,
    sessions: new Set(sets.map((s) => s.workout_id)).size,
    working_sets: working.length,
    total_reps: working.reduce((a, s) => a + s.reps!, 0),
    total_volume_kg: Math.round(volume),
    muscles: [...perMuscle.entries()]
      .map(([muscle, v]) => ({ muscle, ...v }))
      .sort((a, b) => b.weighted_sets - a.weighted_sets || a.muscle.localeCompare(b.muscle)),
    exercises: [...perExercise.entries()]
      .map(([id, v]) => ({ id, name: muscles.get(id)?.name ?? id, working_sets: v.sets, volume_kg: Math.round(v.volume) }))
      .sort((a, b) => b.working_sets - a.working_sets),
  };
}

/** Compact recent sessions for planning: one line per exercise. Includes upcoming planned days. */
export function recentWorkouts(ctx: Ctx, days = 14) {
  const today = trainingDay(ctx.clock());
  const from = addDays(today, -(days - 1));
  const workouts = ctx.db
    .query<{ id: number; date: string; name: string | null; routine_id: number | null }, [string]>(
      "SELECT id, date, name, routine_id FROM workouts WHERE date >= ? ORDER BY date DESC",
    )
    .all(from);
  const bw = bodyweightLookup(ctx.db);
  const blocks = ctx.db.query<
    { workout_id: number; exercise_id: string; name: string; type: string; block_id: number },
    [number]
  >(
    `SELECT we.workout_id, we.exercise_id, e.name, e.type, we.id AS block_id FROM workout_exercises we
     JOIN exercises e ON e.id = we.exercise_id WHERE we.workout_id = ? ORDER BY we.position`,
  );
  const setsQ = ctx.db.query<
    { id: number; type: string; reps: number | null; weight_kg: number | null; duration_s: number | null; distance_m: number | null; rpe: number | null; is_planned: number; set_number: number; target_reps_min: number | null; target_reps_max: number | null; target_weight_kg: number | null },
    [number]
  >("SELECT * FROM sets WHERE workout_exercise_id = ? ORDER BY set_number");
  return {
    from,
    to: today,
    workouts: workouts.map((w) => {
      const exercises = blocks.all(w.id).map((b) => {
        const rows = setsQ.all(b.block_id);
        const performed: StatSet[] = rows
          .filter((r) => r.is_planned === 0)
          .map((r) => ({
            ...r,
            date: w.date,
            workout_id: w.id,
            exercise_id: b.exercise_id,
            exercise_type: b.type,
            load: effectiveLoad(b.type, r.weight_kg, bw(w.date)),
          }));
        const planned = rows.filter((r) => r.is_planned === 1);
        const stats = sessionStats(performed);
        return {
          exercise_id: b.exercise_id,
          name: b.name,
          performed: performed.map(formatSet).join(", ") || null,
          planned: planned.length
            ? planned
                .map((p) => {
                  const reps = p.target_reps_min === p.target_reps_max ? `${p.target_reps_min ?? "?"}` : `${p.target_reps_min ?? "?"}-${p.target_reps_max ?? "?"}`;
                  return p.target_weight_kg != null ? `${roundKg(p.target_weight_kg)}×${reps}` : `×${reps}`;
                })
                .join(", ")
            : null,
          top_set: stats.top_set?.text ?? null,
          e1rm_kg: stats.e1rm_kg,
          volume_kg: stats.volume_kg,
        };
      });
      const performedCount = exercises.filter((e) => e.performed).length;
      return {
        workout_id: w.id,
        date: w.date,
        name: w.name,
        routine_id: w.routine_id,
        status: performedCount === 0 ? "planned" : w.date >= today ? "in_progress" : "completed",
        exercises,
      };
    }),
  };
}
