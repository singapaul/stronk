/** Display helpers. Weights are kg throughout. */
export const kg = (n: number | null | undefined) => (n == null ? "—" : `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, "")}`);

export function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export const volume = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}t` : `${v} kg`);

export const minutes = (m: number | null) => (m == null ? "" : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

/** Today's date in the browser's timezone (London for you), YYYY-MM-DD. */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dayBefore(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export const SET_TYPE_LABEL: Record<string, string> = { warmup: "W", failure: "F", dropset: "D" };
