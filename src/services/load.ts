import type { DB } from "../db.ts";

/** Displayed kg are rounded to the nearest 0.25 (smallest common plate pair). Storage keeps full precision. */
export const roundKg = (kg: number | null): number | null => (kg == null ? null : Math.round(kg * 4) / 4);

const BODYWEIGHT_TYPES = new Set(["bodyweight_reps", "bodyweight_assisted_reps"]);

/** Most recent bodyweight on or before `date`. */
export function bodyweightOn(db: DB, date: string): number | null {
  return (
    db
      .query<{ w: number }, [string]>(
        "SELECT weight_kg AS w FROM body_measurements WHERE date <= ? AND weight_kg IS NOT NULL ORDER BY date DESC LIMIT 1",
      )
      .get(date)?.w ?? null
  );
}

/** Memoised bodyweight lookup for stats passes over many dates. */
export function bodyweightLookup(db: DB) {
  const cache = new Map<string, number | null>();
  return (date: string) => {
    if (!cache.has(date)) cache.set(date, bodyweightOn(db, date));
    return cache.get(date)!;
  };
}

/**
 * The load actually moved. Bodyweight exercises add bodyweight to `weight_kg` (negative = assistance);
 * without a bodyweight on record they have no load. reps_only and time/distance types have none either.
 */
export function effectiveLoad(exerciseType: string, weightKg: number | null, bodyweight: number | null): number | null {
  if (BODYWEIGHT_TYPES.has(exerciseType)) return bodyweight == null ? null : bodyweight + (weightKg ?? 0);
  if (exerciseType === "reps_only") return null;
  return weightKg;
}

/** Epley estimated 1RM. A single is its own 1RM. */
export function epley(load: number, reps: number): number {
  return reps === 1 ? load : load * (1 + reps / 30);
}

export type SetForStats = { type: string; reps: number | null; is_planned: number };

/** Working = performed, not a warm-up, with reps. Dropsets count for volume but not for e1RM/heaviest. */
export const isWorking = (s: SetForStats) => s.is_planned === 0 && s.type !== "warmup" && (s.reps ?? 0) > 0;
export const countsForStrength = (s: SetForStats) => isWorking(s) && s.type !== "dropset";

/** Fields each exercise type expects on a performed set. Mismatches warn, never reject (types are heuristics). */
const EXPECTED: Record<string, (keyof Measures)[]> = {
  weight_reps: ["reps", "weight_kg"],
  reps_only: ["reps"],
  bodyweight_reps: ["reps"],
  bodyweight_assisted_reps: ["reps"],
  duration: ["duration_s"],
  weight_duration: ["weight_kg", "duration_s"],
  distance_duration: ["distance_m"],
  short_distance_weight: ["weight_kg", "distance_m"],
};
type Measures = { reps?: number | null; weight_kg?: number | null; duration_s?: number | null; distance_m?: number | null };

export function typeWarnings(exerciseType: string, s: Measures): string[] {
  const missing = (EXPECTED[exerciseType] ?? []).filter((k) => s[k] == null);
  return missing.length ? [`${exerciseType} exercises usually record ${missing.join(" and ")}`] : [];
}
