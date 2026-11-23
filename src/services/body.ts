import type { Ctx } from "../app.ts";
import { notFound } from "../errors.ts";
import type { BodyweightImportInput, BodyweightInput, BodyweightListInput } from "../schemas.ts";
import { trainingDay } from "./dates.ts";
import { today } from "./workouts.ts";

export type BodyweightSource = "manual" | "health_connect";
type Row = {
  date: string;
  weight_kg: number | null;
  fat_percent: number | null;
  notes: string | null;
  source: BodyweightSource;
  measured_at: string | null;
  updated_at: string;
};
const COLS = "date, weight_kg, fat_percent, notes, source, measured_at, updated_at";

/** One entry per date; writing again replaces it (a synced entry included). Default date is today's training day. */
export function logBodyweight(ctx: Ctx, input: BodyweightInput & { date?: string }) {
  const date = input.date ?? today(ctx);
  ctx.db
    .query(
      `INSERT INTO body_measurements (date, weight_kg, fat_percent, notes) VALUES ($date, $w, $f, $n)
       ON CONFLICT(date) DO UPDATE SET weight_kg = excluded.weight_kg, fat_percent = excluded.fat_percent, notes = excluded.notes,
         source = 'manual', measured_at = NULL`,
    )
    .run({ date, w: input.weight_kg, f: input.fat_percent ?? null, n: input.notes ?? null });
  return ctx.db.query<Row, [string]>(`SELECT ${COLS} FROM body_measurements WHERE date = ?`).get(date)!;
}

export function getBodyweight(ctx: Ctx, input: BodyweightListInput) {
  const entries = ctx.db
    .query<Row, Record<string, string | number>>(
      `SELECT ${COLS} FROM body_measurements
       WHERE date >= $from AND date <= $to ORDER BY date DESC LIMIT $limit`,
    )
    .all({ from: input.from ?? "0000-00-00", to: input.to ?? "9999-99-99", limit: input.limit });
  const withWeight = entries.filter((e) => e.weight_kg != null);
  const change =
    withWeight.length >= 2 ? Math.round((withWeight[0]!.weight_kg! - withWeight[withWeight.length - 1]!.weight_kg!) * 10) / 10 : null;
  return { entries, latest: entries[0] ?? null, change_kg: change };
}

export function deleteBodyweight(ctx: Ctx, date: string) {
  const res = ctx.db.query("DELETE FROM body_measurements WHERE date = ?").run(date);
  if (res.changes === 0) throw notFound(`Bodyweight entry for ${date}`);
  return { deleted: true, date };
}

// ---------------------------------------------------------------------------
// Import from a phone health store (Health Connect via the HC Webhook app).
// ---------------------------------------------------------------------------

export type SkipReason = "manual_entry" | "out_of_range" | "bad_time" | "future" | "no_weight";
type Latest = { at: string; value: number };

/** Readings more than this far ahead of the server clock are treated as a broken phone clock. */
const FUTURE_SLACK_MS = 3600_000;

/**
 * Upsert synced readings, one entry per training day (Europe/London, 04:00 rollover), keeping the
 * latest reading of each day. Safe to resend: the same batch twice changes nothing.
 * - A manual entry for a day is never overwritten.
 * - A synced entry is replaced only by a reading taken later.
 * - Body fat attaches to that day's synced entry; a day with body fat but no weight is skipped.
 */
export function importBodyweight(ctx: Ctx, input: BodyweightImportInput) {
  const skipped: Record<SkipReason, number> = { manual_entry: 0, out_of_range: 0, bad_time: 0, future: 0, no_weight: 0 };
  const latestFrom = (readings: { time: string; value: number }[], min: number, max: number, decimals: number) => {
    const byDay = new Map<string, Latest>();
    const limit = ctx.clock().getTime() + FUTURE_SLACK_MS;
    for (const r of readings) {
      const t = new Date(r.time);
      if (Number.isNaN(t.getTime()) || !/\d{4}-\d{2}-\d{2}T/.test(r.time)) {
        skipped.bad_time++;
        continue;
      }
      if (t.getTime() > limit) {
        skipped.future++;
        continue;
      }
      if (!(r.value >= min && r.value <= max)) {
        skipped.out_of_range++;
        continue;
      }
      const day = trainingDay(t);
      const at = t.toISOString();
      const prev = byDay.get(day);
      if (!prev || at > prev.at) byDay.set(day, { at, value: round(r.value, decimals) });
    }
    return byDay;
  };
  const weights = latestFrom((input.weight ?? []).map((r) => ({ time: r.time, value: r.kilograms })), 20, 400, 2);
  const fats = latestFrom((input.body_fat ?? []).map((r) => ({ time: r.time, value: r.percentage })), 1, 70, 1);

  const updated = new Set<string>();
  let unchanged = 0;
  const get = ctx.db.query<Row, [string]>(`SELECT ${COLS} FROM body_measurements WHERE date = ?`);
  const upsert = ctx.db.query(
    `INSERT INTO body_measurements (date, weight_kg, fat_percent, source, measured_at) VALUES ($date, $w, $f, 'health_connect', $at)
     ON CONFLICT(date) DO UPDATE SET weight_kg = excluded.weight_kg, measured_at = excluded.measured_at,
       fat_percent = COALESCE(excluded.fat_percent, body_measurements.fat_percent)`,
  );
  const setFat = ctx.db.query("UPDATE body_measurements SET fat_percent = $f WHERE date = $date AND fat_percent IS NOT $f");

  ctx.db.transaction(() => {
    for (const [date, w] of [...weights].sort(([a], [b]) => a.localeCompare(b))) {
      const row = get.get(date);
      if (row?.source === "manual") {
        skipped.manual_entry++;
        fats.delete(date);
        continue;
      }
      if (row?.measured_at && row.measured_at >= w.at) {
        // Already have this reading or a later one; its body fat came with it.
        unchanged++;
        fats.delete(date);
        continue;
      }
      upsert.run({ date, w: w.value, f: fats.get(date)?.value ?? null, at: w.at });
      fats.delete(date);
      updated.add(date);
    }
    for (const [date, f] of fats) {
      const row = get.get(date);
      if (!row) skipped.no_weight++;
      else if (row.source === "manual") skipped.manual_entry++;
      else if (setFat.run({ date, f: f.value }).changes > 0) updated.add(date);
      else unchanged++;
    }
  })();

  return { updated: [...updated].sort(), unchanged, skipped };
}

const round = (n: number, decimals: number) => Math.round(n * 10 ** decimals) / 10 ** decimals;
