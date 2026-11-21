import type { Ctx } from "../app.ts";
import { notFound } from "../errors.ts";
import type { BodyweightInput, BodyweightListInput } from "../schemas.ts";
import { today } from "./workouts.ts";

type Row = { date: string; weight_kg: number | null; fat_percent: number | null; notes: string | null; updated_at: string };

/** One entry per date; writing again replaces it. Default date is today's training day. */
export function logBodyweight(ctx: Ctx, input: BodyweightInput & { date?: string }) {
  const date = input.date ?? today(ctx);
  ctx.db
    .query(
      `INSERT INTO body_measurements (date, weight_kg, fat_percent, notes) VALUES ($date, $w, $f, $n)
       ON CONFLICT(date) DO UPDATE SET weight_kg = excluded.weight_kg, fat_percent = excluded.fat_percent, notes = excluded.notes`,
    )
    .run({ date, w: input.weight_kg, f: input.fat_percent ?? null, n: input.notes ?? null });
  return ctx.db.query<Row, [string]>("SELECT date, weight_kg, fat_percent, notes, updated_at FROM body_measurements WHERE date = ?").get(date)!;
}

export function getBodyweight(ctx: Ctx, input: BodyweightListInput) {
  const entries = ctx.db
    .query<Row, Record<string, string | number>>(
      `SELECT date, weight_kg, fat_percent, notes, updated_at FROM body_measurements
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
