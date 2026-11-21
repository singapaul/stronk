/** A clock that can be swapped in tests. */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

const TZ = "Europe/London";
/** Sessions that run past midnight stay on the same day until this hour (London time). */
const DAY_ROLLOVER_HOURS = 4;

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Calendar date (YYYY-MM-DD) of an instant in Europe/London. */
export function londonDate(at: Date): string {
  return dateFmt.format(at);
}

/** The training day for an instant: the London date of (instant - 4h). */
export function trainingDay(at: Date): string {
  return londonDate(new Date(at.getTime() - DAY_ROLLOVER_HOURS * 3600_000));
}

/** Add whole days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type WorkoutStatus = "planned" | "in_progress" | "completed";

/** Status is derived: never stored, so it can't drift. */
export function deriveStatus(date: string, today: string, performedSets: number): WorkoutStatus {
  if (performedSets === 0) return "planned";
  return date >= today ? "in_progress" : "completed";
}
