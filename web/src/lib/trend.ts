/** Series and axis maths for the small SVG charts (no chart library). Pure, so it's unit-tested. */

export type Point = { date: string; value: number };

export type SessionLike = {
  date: string;
  e1rm_kg: number | null;
  top_set: { load_kg: number | null; reps: number | null } | null;
  sets: { type: string; reps: number | null; duration_s: number | null }[];
};

/**
 * One value per session, oldest first, last `limit` sessions: best e1RM when there's a load,
 * otherwise most reps in a working set, otherwise the longest hold.
 */
export function sessionSeries(sessions: SessionLike[], limit = 12): { points: Point[]; unit: string; label: string } {
  const recent = [...sessions].slice(0, limit).reverse();
  if (recent.some((s) => s.e1rm_kg != null)) {
    return { points: recent.filter((s) => s.e1rm_kg != null).map((s) => ({ date: s.date, value: s.e1rm_kg! })), unit: "kg", label: "Estimated 1RM" };
  }
  const reps = recent
    .map((s) => ({ date: s.date, value: Math.max(0, ...s.sets.filter((x) => x.type !== "warmup").map((x) => x.reps ?? 0)) }))
    .filter((p) => p.value > 0);
  if (reps.length) return { points: reps, unit: "reps", label: "Best set" };
  const holds = recent
    .map((s) => ({ date: s.date, value: Math.max(0, ...s.sets.map((x) => x.duration_s ?? 0)) }))
    .filter((p) => p.value > 0);
  return { points: holds, unit: "s", label: "Longest hold" };
}

/** A round step for axis ticks: 1, 2, 2.5 or 5 × a power of ten. */
export function niceStep(range: number, ticks = 3): number {
  if (range <= 0) return 1;
  const raw = range / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

export type Plot = { d: string; dots: { x: number; y: number; value: number; date: string }[]; ticks: { y: number; value: number }[] };

/** Map points into a width×height box with padding; y-axis spans rounded ticks around the data. */
export function plot(points: Point[], width: number, height: number, pad = { t: 8, r: 8, b: 8, l: 36 }): Plot {
  if (points.length === 0) return { d: "", dots: [], ticks: [] };
  const values = points.map((p) => p.value);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const w = width - pad.l - pad.r;
  const h = height - pad.t - pad.b;
  const x = (i: number) => pad.l + (points.length === 1 ? w / 2 : (i / (points.length - 1)) * w);
  const y = (v: number) => pad.t + h - ((v - lo) / (hi - lo)) * h;
  const dots = points.map((p, i) => ({ x: x(i), y: y(p.value), value: p.value, date: p.date }));
  const d = dots.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const ticks: Plot["ticks"] = [];
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push({ y: y(v), value: Math.round(v * 100) / 100 });
  return { d, dots, ticks };
}
