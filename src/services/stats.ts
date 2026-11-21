import type { DB } from "../db.ts";
import { bodyweightLookup, countsForStrength, effectiveLoad, epley, isWorking } from "./load.ts";

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
export function performedSets(db: DB, exerciseId: string, opts: { from?: string; to?: string } = {}): StatSet[] {
  const rows = db
    .query<Omit<StatSet, "load">, { ex: string; from: string; to: string }>(
      `${STAT_SET_SQL}
       WHERE we.exercise_id = $ex AND s.is_planned = 0 AND w.date >= $from AND w.date <= $to
       ORDER BY w.date, s.set_number, s.id`,
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

// Re-exported for routes/MCP that only need the predicates.
export { isWorking };
