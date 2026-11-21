import { describe, expect, test } from "bun:test";
import { seedMini, testApp } from "./helpers.ts";

const setup = () => {
  const t = testApp();
  seedMini(t.db);
  return t;
};

const pushA = {
  name: "Push A",
  notes: "Heavy day",
  exercises: [
    { exercise_id: "bench", rest_seconds: 180, sets: [{ type: "warmup", reps: 10, weight_kg: 40 }, { reps_min: 5, reps_max: 8, weight_kg: 80 }, { reps_min: 5, reps_max: 8, weight_kg: 80 }] },
    { exercise_id: "assisted_dip", superset_group: 1, sets: [{ reps_min: 8, reps_max: 12, weight_kg: -20 }] },
    { exercise_id: "plank", superset_group: 1, sets: [{ duration_s: 60 }] },
  ],
};

describe("routines", () => {
  test("create, get and list", async () => {
    const { call } = setup();
    const created = await call("POST", "/api/routines", pushA);
    expect(created.status).toBe(201);
    expect(created.body.exercises).toHaveLength(3);
    expect(created.body.exercises[0]).toMatchObject({ position: 1, rest_seconds: 180 });
    expect(created.body.exercises[0].sets[1]).toMatchObject({ set_number: 2, reps_min: 5, reps_max: 8, weight_kg: 80, type: "normal" });
    expect(created.body.exercises[1].sets[0].weight_kg).toBe(-20);
    expect(created.body.last_performed).toBeNull();
    const list = await call("GET", "/api/routines");
    expect(list.body.routines[0]).toMatchObject({ name: "Push A", exercises: ["Barbell Bench Press", "Assisted Dip", "Plank"] });
  });

  test("names are unique (case-insensitive)", async () => {
    const { call } = setup();
    await call("POST", "/api/routines", pushA);
    expect((await call("POST", "/api/routines", { ...pushA, name: "push a" })).status).toBe(409);
  });

  test("rejects unknown exercises and duplicate blocks", async () => {
    const { call } = setup();
    const bad = await call("POST", "/api/routines", { name: "X", exercises: [{ exercise_id: "nope", sets: [{ reps: 5 }] }] });
    expect(bad.status).toBe(404);
    const dup = await call("POST", "/api/routines", {
      name: "Y",
      exercises: [{ exercise_id: "bench", sets: [{ reps: 5 }] }, { exercise_id: "bench", sets: [{ reps: 5 }] }],
    });
    expect(dup.status).toBe(400);
  });

  test("PATCH replaces blocks when exercises is given, otherwise keeps them", async () => {
    const { call } = setup();
    const r = await call("POST", "/api/routines", pushA);
    const renamed = await call("PATCH", `/api/routines/${r.body.id}`, { name: "Push 1" });
    expect(renamed.body.exercises).toHaveLength(3);
    const replaced = await call("PATCH", `/api/routines/${r.body.id}`, { exercises: [{ exercise_id: "bench", sets: [{ reps: 5, weight_kg: 85 }] }] });
    expect(replaced.body.name).toBe("Push 1");
    expect(replaced.body.exercises).toHaveLength(1);
    expect(replaced.body.exercises[0].sets[0]).toMatchObject({ reps_min: 5, reps_max: 5, weight_kg: 85 });
  });

  test("start copies the routine into today's workout as planned sets with targets", async () => {
    const { call } = setup();
    const r = await call("POST", "/api/routines", pushA);
    const w = await call("POST", `/api/routines/${r.body.id}/start`);
    expect(w.status).toBe(201);
    expect(w.body).toMatchObject({ date: "2026-03-10", name: "Push A", notes: "Heavy day", routine_id: r.body.id, status: "planned" });
    expect(w.body.totals.planned_sets).toBe(5);
    expect(w.body.exercises[0].rest_seconds).toBe(180);
    expect(w.body.exercises[0].sets[1].target).toMatchObject({ reps_min: 5, reps_max: 8, weight_kg: 80 });
    expect(w.body.exercises[2].sets[0].target.duration_s).toBe(60);
    expect(w.body.exercises[1].superset_group).toBe(1);

    // Logging then fills the routine's planned sets.
    const s = await call("POST", "/api/sets", { exercise_id: "bench", reps: 8, weight_kg: 80 });
    expect(s.body.filled_planned).toBe(true);
    expect(s.body.set.target).toMatchObject({ reps_min: 5, reps_max: 8 });
    expect((await call("GET", `/api/routines/${r.body.id}`)).body.last_performed).toBe("2026-03-10");
  });

  test("starting onto a day that already has a workout merges into it", async () => {
    const { call } = setup();
    const logged = await call("POST", "/api/sets", { exercise_id: "squat", reps: 5, weight_kg: 100 });
    const r = await call("POST", "/api/routines", pushA);
    const w = await call("POST", `/api/routines/${r.body.id}/start`, {});
    expect(w.body.id).toBe(logged.body.workout_id);
    expect(w.body.exercises.map((e: any) => e.exercise.id)).toEqual(["squat", "bench", "assisted_dip", "plank"]);
    expect(w.body.routine_id).toBe(r.body.id);
  });

  test("start for another date, and deleting a routine keeps its workouts", async () => {
    const { call } = setup();
    const r = await call("POST", "/api/routines", pushA);
    const w = await call("POST", `/api/routines/${r.body.id}/start`, { date: "2026-03-12" });
    expect(w.body.date).toBe("2026-03-12");
    expect((await call("DELETE", `/api/routines/${r.body.id}`)).status).toBe(200);
    const after = await call("GET", `/api/workouts/${w.body.id}`);
    expect(after.status).toBe(200);
    expect(after.body.routine_id).toBeNull();
  });

  test("unknown routine 404s and lists the ones that exist", async () => {
    const { call } = setup();
    await call("POST", "/api/routines", pushA);
    const res = await call("POST", "/api/routines/999/start");
    expect(res.status).toBe(404);
    expect(res.body.details.routines[0].name).toBe("Push A");
  });
});

describe("bodyweight", () => {
  test("PUT upserts per date, GET lists newest first with change", async () => {
    const { call } = setup();
    await call("PUT", "/api/bodyweight/2026-03-01", { weight_kg: 82 });
    await call("PUT", "/api/bodyweight/2026-03-08", { weight_kg: 81.2, fat_percent: 15 });
    const replaced = await call("PUT", "/api/bodyweight/2026-03-08", { weight_kg: 81 });
    expect(replaced.body).toMatchObject({ date: "2026-03-08", weight_kg: 81, fat_percent: null });
    const list = await call("GET", "/api/bodyweight");
    expect(list.body.entries.map((e: any) => e.date)).toEqual(["2026-03-08", "2026-03-01"]);
    expect(list.body.change_kg).toBe(-1);
  });

  test("validates and deletes", async () => {
    const { call } = setup();
    expect((await call("PUT", "/api/bodyweight/2026-03-01", { weight_kg: 5 })).status).toBe(400);
    expect((await call("PUT", "/api/bodyweight/not-a-date", { weight_kg: 80 })).status).toBe(400);
    await call("PUT", "/api/bodyweight/2026-03-01", { weight_kg: 80 });
    expect((await call("DELETE", "/api/bodyweight/2026-03-01")).status).toBe(200);
    expect((await call("DELETE", "/api/bodyweight/2026-03-01")).status).toBe(404);
  });

  test("bodyweight gives pull-ups and assisted dips a real load", async () => {
    const { call } = setup();
    await call("PUT", "/api/bodyweight/2026-03-01", { weight_kg: 80 });
    const res = await call("POST", "/api/workouts", {
      exercises: [
        { exercise_id: "pullup", sets: [{ reps: 10 }, { reps: 5, weight_kg: 20 }] },
        { exercise_id: "assisted_dip", sets: [{ reps: 10, weight_kg: -20 }] },
      ],
    });
    // 10×80 + 5×100 + 10×60
    expect(res.body.workout.totals.volume_kg).toBe(1900);
  });
});
