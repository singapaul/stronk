import { describe, expect, test } from "bun:test";
import { epley } from "../src/services/load.ts";
import { formatSet } from "../src/services/stats.ts";
import { seedMini, testApp } from "./helpers.ts";

const setup = async () => {
  const t = testApp();
  seedMini(t.db);
  const log = (date: string, exercises: unknown[]) => t.call("POST", "/api/workouts", { date, exercises });
  await log("2026-03-02", [
    { exercise_id: "bench", sets: [{ type: "warmup", reps: 10, weight_kg: 40 }, { reps: 5, weight_kg: 80 }, { reps: 5, weight_kg: 80, rpe: 8 }] },
    { exercise_id: "squat", sets: [{ reps: 5, weight_kg: 100 }] },
  ]);
  await log("2026-03-05", [
    { exercise_id: "bench", sets: [{ reps: 3, weight_kg: 90 }, { reps: 8, weight_kg: 80 }, { type: "dropset", reps: 15, weight_kg: 95 }] },
    { exercise_id: "plank", sets: [{ duration_s: 60 }, { duration_s: 90 }] },
  ]);
  return t;
};

describe("maths", () => {
  test("Epley", () => {
    expect(epley(100, 1)).toBe(100);
    expect(epley(100, 5)).toBeCloseTo(116.667, 2);
    expect(epley(80, 8)).toBeCloseTo(101.333, 2);
  });

  test("formatSet", () => {
    const base = { exercise_type: "weight_reps", type: "normal", reps: 5, weight_kg: 80, duration_s: null, distance_m: null, rpe: 8 };
    expect(formatSet(base)).toBe("80×5 @8");
    expect(formatSet({ ...base, type: "warmup", rpe: null })).toBe("(w) 80×5");
    expect(formatSet({ ...base, exercise_type: "bodyweight_assisted_reps", weight_kg: -20, rpe: null })).toBe("BW-20×5");
    expect(formatSet({ ...base, exercise_type: "bodyweight_reps", weight_kg: null, rpe: null })).toBe("BW×5");
    expect(formatSet({ ...base, exercise_type: "duration", reps: null, weight_kg: null, duration_s: 60, rpe: null })).toBe("60s");
  });
});

describe("history", () => {
  test("sessions newest first with top set, volume and e1RM from working sets", async () => {
    const { call } = await setup();
    const { body } = await call("GET", "/api/exercises/bench/history");
    expect(body.total_sessions).toBe(2);
    const [latest, earlier] = body.sessions;
    expect(latest.date).toBe("2026-03-05");
    // Dropset at 95 is not the top set and doesn't drive e1RM, but does count for volume.
    expect(latest.top_set).toMatchObject({ load_kg: 90, reps: 3 });
    expect(latest.e1rm_kg).toBeCloseTo(epley(80, 8), 1); // 101.3 > 90×3 (99)
    expect(latest.volume_kg).toBe(90 * 3 + 80 * 8 + 95 * 15);
    // Warm-up excluded from volume.
    expect(earlier.volume_kg).toBe(800);
    expect(earlier.working_sets).toBe(2);
    expect(earlier.summary).toBe("(w) 40×10, 80×5, 80×5 @8");
  });

  test("limit, date range and flat set format", async () => {
    const { call } = await setup();
    expect((await call("GET", "/api/exercises/bench/history?limit=1")).body.sessions).toHaveLength(1);
    const ranged = await call("GET", "/api/exercises/bench/history?from=2026-03-03");
    expect(ranged.body.sessions.map((s: any) => s.date)).toEqual(["2026-03-05"]);
    const flat = await call("GET", "/api/exercises/bench/history?format=sets&limit=2");
    expect(flat.body.sets).toHaveLength(2);
    expect(flat.body.sets[0]).toMatchObject({ date: "2026-03-05", type: "dropset" });
  });

  test("planned sets never appear in history", async () => {
    const { call } = await setup();
    await call("POST", "/api/workouts/plan", { name: "Next", date: "2026-03-12", exercises: [{ exercise_id: "bench", sets: [{ reps: 5, weight_kg: 200 }] }] });
    const { body } = await call("GET", "/api/exercises/bench/history");
    expect(body.total_sessions).toBe(2);
  });

  test("unknown exercise 404s with suggestions", async () => {
    const { call } = await setup();
    const res = await call("GET", "/api/exercises/benchh/history");
    expect(res.status).toBe(404);
    expect(res.body.details.suggestions.length).toBeGreaterThan(0);
  });
});

describe("PRs", () => {
  test("heaviest, best e1RM and best reps at each weight; dropsets and warm-ups excluded", async () => {
    const { call } = await setup();
    const { body } = await call("GET", "/api/prs?exercise_id=bench");
    expect(body.records).toHaveLength(1);
    const bench = body.records[0];
    expect(bench.heaviest).toMatchObject({ load_kg: 90, reps: 3, date: "2026-03-05" });
    expect(bench.best_e1rm).toMatchObject({ load_kg: 80, reps: 8, e1rm_kg: 101.3 });
    expect(bench.best_reps_at_weight).toEqual([
      { load_kg: 90, reps: 3, date: "2026-03-05" },
      { load_kg: 80, reps: 8, date: "2026-03-05" },
    ]);
  });

  test("covers all exercises, including timed ones", async () => {
    const { call } = await setup();
    const { body } = await call("GET", "/api/prs");
    const ids = body.records.map((r: any) => r.exercise.id);
    expect(ids).toEqual(["squat", "bench", "plank"]);
    expect(body.records.find((r: any) => r.exercise.id === "plank").longest_duration.duration_s).toBe(90);
  });
});

describe("summary", () => {
  test("sessions, volume and fractional muscle sets over a range", async () => {
    const { call } = await setup();
    const { body } = await call("GET", "/api/summary?from=2026-03-01&to=2026-03-07");
    expect(body.sessions).toBe(2);
    // bench 2 + 3, squat 1 (plank has no reps, so it isn't a working set)
    expect(body.working_sets).toBe(6);
    expect(body.total_volume_kg).toBe(800 + 100 * 5 + (270 + 640 + 1425));
    const m = Object.fromEntries(body.muscles.map((x: any) => [x.muscle, x]));
    expect(m.chest).toEqual({ muscle: "chest", primary_sets: 5, weighted_sets: 5 });
    expect(m.triceps).toEqual({ muscle: "triceps", primary_sets: 0, weighted_sets: 2.5 });
    expect(m.quadriceps.primary_sets).toBe(1);
    expect(m.glutes.weighted_sets).toBe(0.5);
  });

  test("defaults to the last 7 days", async () => {
    const { call } = await setup();
    const { body } = await call("GET", "/api/summary");
    expect(body).toMatchObject({ from: "2026-03-04", to: "2026-03-10", sessions: 1 });
  });
});

describe("recent", () => {
  test("compact lines per exercise, including planned days", async () => {
    const { call } = await setup();
    await call("POST", "/api/workouts/plan", { name: "Push", date: "2026-03-11", exercises: [{ exercise_id: "bench", sets: [{ reps_min: 5, reps_max: 8, weight_kg: 82.5 }] }] });
    const { body } = await call("GET", "/api/recent?days=7");
    expect(body.workouts.map((w: any) => [w.date, w.status])).toEqual([
      ["2026-03-11", "planned"],
      ["2026-03-05", "completed"],
    ]);
    expect(body.workouts[0].exercises[0].planned).toBe("82.5×5-8");
    expect(body.workouts[1].exercises[0]).toMatchObject({ performed: "90×3, 80×8, (d) 95×15", top_set: "90×3" });
  });
});
