/**
 * Rest timer maths. The timer is stored as an end timestamp, so it stays correct when the phone
 * sleeps, the tab is backgrounded or the page reloads.
 */
export type RestTimer = { endsAt: number; total: number; label: string };

export const DEFAULT_REST_S = 120;

export function startRest(now: number, seconds: number | null | undefined, label: string): RestTimer {
  const s = seconds && seconds > 0 ? seconds : DEFAULT_REST_S;
  return { endsAt: now + s * 1000, total: s, label };
}

export const remainingS = (t: RestTimer, now: number) => Math.max(0, Math.ceil((t.endsAt - now) / 1000));

/** ±seconds; never goes below zero remaining. */
export function adjustRest(t: RestTimer, deltaS: number, now: number): RestTimer {
  const endsAt = Math.max(now, t.endsAt + deltaS * 1000);
  return { ...t, endsAt, total: Math.max(1, t.total + deltaS) };
}

/** 95 → "1:35"; 3725 → "1:02:05". */
export function formatClock(totalS: number): string {
  const s = Math.max(0, Math.floor(totalS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
