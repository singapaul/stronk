import { describe, expect, test } from "bun:test";
import { seedMini, testApp } from "./helpers.ts";

/** Default clock: 2026-03-10 18:00 London, so "today" is 2026-03-10. */
const setup = () => {
  const t = testApp();
  seedMini(t.db);
  return t;
};

describe("log set", () => {
  test("with no workout, creates today's workout and the exercise block", async () => {
    const { call } = setup();
    const res = await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80 });
    expect(res.status).toBe(201);
    expect(res.body.date).toBe("2026-03-10");
    expect(res.body.set.set_number).toBe(1);
    expect(res.body.set.performed_at).toBe("2026-03-10T18:00:00.000Z");
    const w = await call("GET", `/api/workouts/${res.body.workout_id}`);
    expect(w.body.status).toBe("in_progress");
    expect(w.body.exercises).toHaveLength(1);
    expect(w.body.exercises[0].exercise.id).toBe("bench");
  });

  test("auto-numbers sets per exercise and reuses the day's workout", async () => {
    const { call } = setup();
    const a = await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80 });
    const b = await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80 });
    const c = await call("POST", "/api/sets", { exercise_id: "squat", reps: 5, weight_kg: 100 });
    expect(b.body.workout_id).toBe(a.body.workout_id);
    expect(c.body.workout_id).toBe(a.body.workout_id);
    expect(b.body.set.set_number).toBe(2);
    expect(c.body.set.set_number).toBe(1);
    const w = await call("GET", `/api/workouts/${a.body.workout_id}`);
    expect(w.body.exercises.map((e: any) => e.position)).toEqual([1, 2]);
  });

  test("after midnight but before 04:00 still goes to yesterday's workout", async () => {
    const { call, clock } = setup();
    const a = await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80 });
    clock.set("2026-03-11T00:30:00Z");
    const b = await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80 });
    expect(b.body.workout_id).toBe(a.body.workout_id);
    clock.set("2026-03-11T04:30:00Z");
    const c = await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80 });
    expect(c.body.date).toBe("2026-03-11");
  });

  test("backfill by date leaves performed_at empty", async () => {
    const { call } = setup();
    const res = await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80, date: "2026-03-01" });
    expect(res.body.date).toBe("2026-03-01");
    expect(res.body.set.performed_at).toBeNull();
  });

  test("unknown exercise returns suggestions", async () => {
    const { call } = setup();
    const res = await call("POST", "/api/sets", { exercise_id: "bench_press", reps: 5, weight_kg: 80 });
    expect(res.status).toBe(404);
    expect(res.body.details.suggestions.map((s: any) => s.id)).toContain("bench");
  });

  test("needs reps, duration or distance", async () => {
    const { call } = setup();
    expect((await call("POST", "/api/sets", { exercise_id: "bench", weight_kg: 80 })).status).toBe(400);
  });

  test("warns when a set doesn't fit the exercise type", async () => {
    const { call } = setup();
    const res = await call("POST", "/api/sets", { exercise_id: "plank", reps: 1 });
    expect(res.body.warnings[0]).toContain("duration_s");
    const ok = await call("POST", "/api/sets", { exercise_id: "plank", duration_s: 60 });
    expect(ok.body.warnings).toEqual([]);
  });

  test("workout_id and date must agree", async () => {
    const { call } = setup();
    const a = await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80 });
    const bad = await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, workout_id: a.body.workout_id, date: "2026-01-01" });
    expect(bad.status).toBe(400);
  });
});

describe("plans", () => {
  const plan = {
    name: "Push A",
    exercises: [
      {
        exercise_id: "bench",
        rest_seconds: 180,
        sets: [{ type: "warmup", reps: 10, weight_kg: 40 }, { reps_min: 5, reps_max: 8, weight_kg: 80 }, { reps_min: 5, reps_max: 8, weight_kg: 80 }],
      },
    ],
  };

  test("planned workout derives status planned", async () => {
    const { call } = setup();
    const res = await call("POST", "/api/workouts/plan", plan);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("planned");
    expect(res.body.totals).toEqual({ performed_sets: 0, planned_sets: 3, volume_kg: 0 });
    expect(res.body.exercises[0].sets[1].target).toMatchObject({ reps_min: 5, reps_max: 8, weight_kg: 80 });
  });

  test("log_set fills the next planned set of the same kind, keeping targets", async () => {
    const { call } = setup();
    await call("POST", "/api/workouts/plan", plan);
    const first = await call("POST", "/api/sets", { exercise_id: "bench", reps: 6, weight_kg: 80 });
    expect(first.body.filled_planned).toBe(true);
    expect(first.body.set.set_number).toBe(2); // skipped the planned warm-up
    expect(first.body.set.target.reps_min).toBe(5);
    expect(first.body.planned_remaining).toBe(2);
    const warm = await call("POST", "/api/sets", { exercise_id: "bench", type: "warmup", reps: 10, weight_kg: 40 });
    expect(warm.body.set.set_number).toBe(1);
    await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80 });
    const extra = await call("POST", "/api/sets", { exercise_id: "bench", reps: 4, weight_kg: 80 });
    expect(extra.body.filled_planned).toBe(false);
    expect(extra.body.set.set_number).toBe(4);
    expect(extra.body.next_planned).toBeNull();
  });

  test("planning onto a day with a workout merges into it", async () => {
    const { call } = setup();
    const logged = await call("POST", "/api/sets", { exercise_id: "squat", reps: 5, weight_kg: 100 });
    const planned = await call("POST", "/api/workouts/plan", plan);
    expect(planned.body.id).toBe(logged.body.workout_id);
    expect(planned.body.name).toBe("Push A");
    expect(planned.body.exercises.map((e: any) => e.exercise.id)).toEqual(["squat", "bench"]);
    expect(planned.body.status).toBe("in_progress");
  });

  test("complete_planned_set targets a specific set; completing twice is 409", async () => {
    const { call } = setup();
    const p = await call("POST", "/api/workouts/plan", plan);
    const setId = p.body.exercises[0].sets[2].id;
    const done = await call("POST", `/api/sets/${setId}/complete`, { reps: 7, weight_kg: 82.5, rpe: 8 });
    expect(done.status).toBe(200);
    expect(done.body.set).toMatchObject({ is_planned: false, reps: 7, weight_kg: 82.5, rpe: 8 });
    expect(done.body.set.target.reps_max).toBe(8);
    expect((await call("POST", `/api/sets/${setId}/complete`, { reps: 7 })).status).toBe(409);
  });

  test("leftover planned sets on past days are marked skipped and status is completed", async () => {
    const { call, clock } = setup();
    const p = await call("POST", "/api/workouts/plan", plan);
    await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80 });
    clock.set("2026-03-12T12:00:00Z");
    const w = await call("GET", `/api/workouts/${p.body.id}`);
    expect(w.body.status).toBe("completed");
    expect(w.body.exercises[0].sets.filter((s: any) => s.skipped)).toHaveLength(2);
  });
});

describe("log workout", () => {
  test("logs blocks with supersets and notes in one go, with explicit times", async () => {
    const { call } = setup();
    const res = await call("POST", "/api/workouts", {
      date: "2026-03-08",
      name: "Upper",
      start_time: "2026-03-08T10:00:00Z",
      end_time: "2026-03-08T11:05:00Z",
      exercises: [
        { exercise_id: "bench", superset_group: 1, notes: "paused", sets: [{ reps: 5, weight_kg: 80 }, { reps: 5, weight_kg: 80 }] },
        { exercise_id: "pullup", superset_group: 1, sets: [{ reps: 8 }] },
      ],
    });
    expect(res.status).toBe(201);
    const w = res.body.workout;
    expect(w.status).toBe("completed");
    expect(w.duration_min).toBe(65);
    expect(w.exercises[0]).toMatchObject({ superset_group: 1, notes: "paused" });
    expect(w.totals.performed_sets).toBe(3);
    expect(w.totals.volume_kg).toBe(800); // pull-ups have no load without a bodyweight on record
  });

  test("REST can create an empty workout; a second POST for the date merges", async () => {
    const { call } = setup();
    const a = await call("POST", "/api/workouts", { date: "2026-03-09", name: "Legs" });
    const b = await call("POST", "/api/workouts", { date: "2026-03-09", name: "Ignored", notes: "felt good", exercises: [{ exercise_id: "squat", sets: [{ reps: 5, weight_kg: 100 }] }] });
    expect(b.body.workout.id).toBe(a.body.workout.id);
    expect(b.body.workout.name).toBe("Legs");
    expect(b.body.workout.notes).toBe("felt good");
  });

  test("validates every exercise before writing anything", async () => {
    const { call, db } = setup();
    const res = await call("POST", "/api/workouts", {
      exercises: [{ exercise_id: "bench", sets: [{ reps: 5, weight_kg: 80 }] }, { exercise_id: "nope", sets: [{ reps: 1 }] }],
    });
    expect(res.status).toBe(404);
    expect(db.query("SELECT COUNT(*) AS n FROM sets").get()).toEqual({ n: 0 });
  });

  test("derives timing from performed sets when live-logged", async () => {
    const { call, clock } = setup();
    const a = await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80 });
    clock.set("2026-03-10T18:45:00Z");
    await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80 });
    const w = await call("GET", `/api/workouts/${a.body.workout_id}`);
    expect(w.body.start_time).toBe("2026-03-10T18:00:00.000Z");
    expect(w.body.duration_min).toBe(45);
  });
});

describe("edits", () => {
  test("deleting a set renumbers the block; deleting the last removes the block", async () => {
    const { call } = setup();
    const s1 = await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80 });
    const s2 = await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80 });
    const s3 = await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80 });
    await call("POST", "/api/sets", { exercise_id: "squat", reps: 5, weight_kg: 100 });
    await call("DELETE", `/api/sets/${s2.body.set.id}`);
    let w = await call("GET", `/api/workouts/${s1.body.workout_id}`);
    expect(w.body.exercises[0].sets.map((s: any) => [s.id, s.set_number])).toEqual([
      [s1.body.set.id, 1],
      [s3.body.set.id, 2],
    ]);
    await call("DELETE", `/api/sets/${s1.body.set.id}`);
    await call("DELETE", `/api/sets/${s3.body.set.id}`);
    w = await call("GET", `/api/workouts/${s1.body.workout_id}`);
    expect(w.body.exercises.map((e: any) => [e.exercise.id, e.position])).toEqual([["squat", 1]]);
  });

  test("PATCH set updates fields and can clear with null", async () => {
    const { call } = setup();
    const s = await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 800, rpe: 9 });
    const res = await call("PATCH", `/api/sets/${s.body.set.id}`, { weight_kg: 80, rpe: null });
    expect(res.body.set).toMatchObject({ weight_kg: 80, rpe: null, reps: 5 });
  });

  test("PATCH workout date to a taken day is 409", async () => {
    const { call } = setup();
    const a = await call("POST", "/api/workouts", { date: "2026-03-01" });
    await call("POST", "/api/workouts", { date: "2026-03-02" });
    expect((await call("PATCH", `/api/workouts/${a.body.workout.id}`, { date: "2026-03-02" })).status).toBe(409);
    expect((await call("PATCH", `/api/workouts/${a.body.workout.id}`, { date: "2026-03-03", name: "Moved" })).body.name).toBe("Moved");
  });

  test("moving a block reorders the others", async () => {
    const { call } = setup();
    await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80 });
    await call("POST", "/api/sets", { exercise_id: "squat", reps: 5, weight_kg: 100 });
    const last = await call("POST", "/api/sets", { exercise_id: "plank", duration_s: 60 });
    const w = await call("GET", `/api/workouts/${last.body.workout_id}`);
    const plankBlock = w.body.exercises[2].block_id;
    const moved = await call("PATCH", `/api/workout-exercises/${plankBlock}`, { position: 1, notes: "first" });
    expect(moved.body.exercises.map((e: any) => e.exercise.id)).toEqual(["plank", "bench", "squat"]);
    expect(moved.body.exercises[0].notes).toBe("first");
  });

  test("DELETE workout cascades", async () => {
    const { call, db } = setup();
    const s = await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80 });
    expect((await call("DELETE", `/api/workouts/${s.body.workout_id}`)).status).toBe(200);
    expect(db.query("SELECT COUNT(*) AS n FROM sets").get()).toEqual({ n: 0 });
    expect((await call("GET", `/api/workouts/${s.body.workout_id}`)).status).toBe(404);
  });
});

describe("listing", () => {
  test("filters by date range and updated_since", async () => {
    const { call, db } = setup();
    await call("POST", "/api/workouts", { date: "2026-03-01", exercises: [{ exercise_id: "bench", sets: [{ reps: 5, weight_kg: 80 }] }] });
    await call("POST", "/api/workouts", { date: "2026-03-05", exercises: [{ exercise_id: "squat", sets: [{ reps: 5, weight_kg: 100 }] }] });
    const all = await call("GET", "/api/workouts");
    expect(all.body.workouts.map((w: any) => w.date)).toEqual(["2026-03-05", "2026-03-01"]);
    expect(all.body.workouts[0].exercises).toEqual(["Barbell Squat"]);
    const ranged = await call("GET", "/api/workouts?from=2026-03-02&to=2026-03-31");
    expect(ranged.body.workouts).toHaveLength(1);
    db.run("UPDATE workouts SET updated_at = '2020-01-01T00:00:00.000Z' WHERE date = '2026-03-01'");
    const since = await call("GET", "/api/workouts?updated_since=2025-01-01T00:00:00Z");
    expect(since.body.workouts.map((w: any) => w.date)).toEqual(["2026-03-05"]);
  });

  test("GET /today and /by-date", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/workouts/today")).status).toBe(404);
    await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80 });
    expect((await call("GET", "/api/workouts/today")).body.date).toBe("2026-03-10");
    expect((await call("GET", "/api/workouts/by-date/2026-03-10")).status).toBe(200);
  });
});

describe("PR flags", () => {
  test("first set isn't a PR; heavier, better e1RM and more reps at weight are", async () => {
    const { call } = setup();
    const first = await call("POST", "/api/sets", { exercise_id: "bench", reps: 5, weight_kg: 80, date: "2026-03-01" });
    expect(first.body.is_pr).toBe(false);
    const heavier = await call("POST", "/api/sets", { exercise_id: "bench", reps: 3, weight_kg: 85, date: "2026-03-03" });
    expect(heavier.body.pr).toEqual({ heaviest: true, e1rm: true, reps_at_weight: false });
    const moreReps = await call("POST", "/api/sets", { exercise_id: "bench", reps: 7, weight_kg: 80 });
    expect(moreReps.body.pr.reps_at_weight).toBe(true);
    expect(moreReps.body.pr.heaviest).toBe(false);
    const warm = await call("POST", "/api/sets", { exercise_id: "bench", type: "warmup", reps: 20, weight_kg: 90 });
    expect(warm.body.is_pr).toBe(false);
    const drop = await call("POST", "/api/sets", { exercise_id: "bench", type: "dropset", reps: 15, weight_kg: 90 });
    expect(drop.body.is_pr).toBe(false);
  });
});
