import { describe, expect, test } from "bun:test";
import { groupBlocks, nextUp, order, supersetLetter, type RoundBlock } from "../../web/src/lib/rounds.ts";
import { niceStep, plot, sessionSeries } from "../../web/src/lib/trend.ts";

const rows = (prefix: string, n: number, opts: { warm?: number; done?: number } = {}) => [
  ...Array.from({ length: opts.warm ?? 0 }, (_, i) => ({ key: `${prefix}w${i}`, type: "warmup", done: false })),
  ...Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i + 1}`, type: "normal", done: i < (opts.done ?? 0) })),
];

describe("superset rounds", () => {
  const blocks: RoundBlock[] = [
    { superset: 1, rows: rows("sq", 3) }, // A1 squat
    { superset: 1, rows: rows("df", 3) }, // A2 dragon flag
    { superset: null, rows: rows("bp", 2, { warm: 1 }) }, // solo bench with a warm-up
    { superset: 2, rows: rows("cu", 2) }, // B1 curl
    { superset: 2, rows: rows("sk", 3) }, // B2 skull crusher (one more set)
  ];
  const groups = groupBlocks(blocks);

  test("groups superset members into one card with A1/A2 tags, solos stay single", () => {
    expect(groups.map((g) => g.kind)).toEqual(["superset", "single", "superset"]);
    const a = groups[0]!;
    expect(a.kind === "superset" && a.members.map((m) => m.tag)).toEqual(["A1", "A2"]);
    expect(supersetLetter(2)).toBe("B");
  });

  test("interleaves working sets by round; extra sets get rounds of their own; warm-ups first", () => {
    const a = groups[0]!;
    expect(a.rounds.map((r) => [r.label, r.entries.map((e) => e.row)])).toEqual([
      ["Round 1", ["sq1", "df1"]],
      ["Round 2", ["sq2", "df2"]],
      ["Round 3", ["sq3", "df3"]],
    ]);
    expect(groups[1]!.rounds.map((r) => r.label)).toEqual(["Warm-up", "Set 1", "Set 2"]);
    expect(groups[2]!.rounds.at(-1)!.entries.map((e) => e.row)).toEqual(["sk3"]);
    expect(order(groups).slice(0, 3).map((e) => e.row)).toEqual(["sq1", "df1", "sq2"]);
  });

  test("next up follows the round order and wraps to anything missed", () => {
    expect(nextUp(groups, blocks)).toEqual({ block: 0, row: "sq1" });
    expect(nextUp(groups, blocks, { block: 0, row: "sq1" })).toEqual({ block: 1, row: "df1" });
    expect(nextUp(groups, blocks, { block: 1, row: "df1" })).toEqual({ block: 0, row: "sq2" });
    const allButFirst = blocks.map((b, i) => ({ ...b, rows: b.rows.map((r) => ({ ...r, done: !(i === 0 && r.key === "sq1") })) }));
    expect(nextUp(groups, allButFirst, { block: 4, row: "sk3" })).toEqual({ block: 0, row: "sq1" });
    const allDone = blocks.map((b) => ({ ...b, rows: b.rows.map((r) => ({ ...r, done: true })) }));
    expect(nextUp(groups, allDone)).toBeNull();
  });
});

describe("trend", () => {
  const s = (date: string, e1rm: number | null, sets: { type: string; reps: number | null; duration_s: number | null }[] = []) => ({
    date,
    e1rm_kg: e1rm,
    top_set: null,
    sets,
  });

  test("uses e1RM when there's a load, oldest first", () => {
    const r = sessionSeries([s("2026-03-10", 104.5), s("2026-03-03", 101.3)]);
    expect(r).toEqual({ points: [{ date: "2026-03-03", value: 101.3 }, { date: "2026-03-10", value: 104.5 }], unit: "kg", label: "Estimated 1RM" });
  });

  test("falls back to best reps, then the longest hold", () => {
    expect(sessionSeries([s("2026-03-10", null, [{ type: "normal", reps: 8, duration_s: null }, { type: "warmup", reps: 20, duration_s: null }])]).points[0]!.value).toBe(8);
    expect(sessionSeries([s("2026-03-10", null, [{ type: "normal", reps: null, duration_s: 45 }])])).toMatchObject({ unit: "s", points: [{ value: 45 }] });
  });

  test("nice steps and plotting", () => {
    expect(niceStep(10)).toBe(5);
    expect(niceStep(7)).toBe(2.5);
    expect(niceStep(0.3)).toBe(0.1);
    const p = plot([{ date: "a", value: 100 }, { date: "b", value: 110 }], 200, 100);
    expect(p.d.startsWith("M36.0 ")).toBe(true);
    expect(p.dots[1]!.x).toBe(192);
    expect(p.ticks[0]!.value).toBeLessThanOrEqual(100);
    expect(p.ticks.at(-1)!.value).toBeGreaterThanOrEqual(110);
    expect(plot([], 10, 10)).toEqual({ d: "", dots: [], ticks: [] });
  });
});
