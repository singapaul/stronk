/** Turning Claude's targets and last session's numbers into the values shown in a set row. */

export type Target = {
  reps_min: number | null;
  reps_max: number | null;
  weight_kg: number | null;
  rpe: number | null;
  duration_s: number | null;
  distance_m: number | null;
} | null;

export type PastSet = { set_number: number; type: string; reps: number | null; weight_kg: number | null; duration_s?: number | null };

/** Inputs start at the target: its weight and the top of its rep range. */
export function prefill(target: Target): { kg: number | null; reps: number | null; duration_s: number | null } {
  if (!target) return { kg: null, reps: null, duration_s: null };
  return { kg: target.weight_kg, reps: target.reps_max ?? target.reps_min, duration_s: target.duration_s };
}

/** "80×5-8 @8", "60s", "×10", or "" with no target. */
export function describeTarget(target: Target): string {
  if (!target) return "";
  const reps =
    target.reps_min == null && target.reps_max == null
      ? null
      : target.reps_min === target.reps_max || target.reps_max == null
        ? `${target.reps_min ?? target.reps_max}`
        : target.reps_min == null
          ? `${target.reps_max}`
          : `${target.reps_min}-${target.reps_max}`;
  let core: string;
  if (target.duration_s != null && reps == null) core = `${target.duration_s}s`;
  else if (target.weight_kg != null) core = `${target.weight_kg}×${reps ?? "?"}`;
  else core = reps ? `×${reps}` : "";
  return `${core}${target.rpe != null ? ` @${target.rpe}` : ""}`.trim();
}

/** Last session's matching set: same set number, else the same position among working sets. */
export function lastFor(previous: PastSet[], setNumber: number, type: string): PastSet | null {
  const exact = previous.find((s) => s.set_number === setNumber);
  if (exact) return exact;
  const sameKind = previous.filter((s) => (type === "warmup") === (s.type === "warmup"));
  return sameKind[sameKind.length - 1] ?? null;
}

export function describePast(s: PastSet | null): string {
  if (!s) return "—";
  if (s.reps == null && s.duration_s != null) return `${s.duration_s}s`;
  return s.weight_kg != null ? `${s.weight_kg}×${s.reps ?? "?"}` : `${s.reps ?? "?"} reps`;
}
