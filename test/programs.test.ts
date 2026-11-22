import { describe, expect, test } from "bun:test";
import { seedMini, testApp } from "./helpers.ts";

/** Default clock: 2026-03-10 18:00 London. */
async function setup() {
  const t = testApp();
  seedMini(t.db);
  const routine = async (name: string, exercises: unknown[]) => (await t.call("POST", "/api/routines", { name, exercises })).body;
  const push = await routine("Push A", [
    { exercise_id: "bench", rest_seconds: 180, sets: [{ reps_min: 5, reps_max: 8, weight_kg: 80 }, { reps_min: 5, reps_max: 8, weight_kg: 80 }] },
  ]);
  const pull = await routine("Pull A", [{ exercise_id: "pullup", sets: [{ reps_min: 6, reps_max: 10 }] }]);
  const legs = await routine("Legs A", [{ exercise_id: "squat", sets: [{ reps_min: 5, reps_max: 6, weight_kg: 100 }] }]);
  const create = (extra: object = {}) =>
    t.call("POST", "/api/programs", { name: "PPL", routine_ids: [push.id, pull.id, legs.id], ...extra });
  const next = (date?: string) => t.call("POST", "/api/programs/next-workout", date ? { date } : {});
  const log = (exercise_id: string, reps: number, weight_kg: number | undefined, date: string, rpe?: number) =>
    t.call("POST", "/api/sets", { exercise_id, reps, ...(weight_kg != null ? { weight_kg } : {}), date, ...(rpe ? { rpe } : {}) });
  /** Do every slot of the current cycle on consecutive days from `start`. */
  const runCycle = async (start: number, perf: { bench?: number[]; pullup?: number[]; squat?: number[]; benchKg?: number } = {}) => {
    const d = (n: number) => `2026-03-${String(n).padStart(2, "0")}`;
    await next(d(start));
    for (const r of perf.bench ?? [8, 8]) await log("bench", r, perf.benchKg ?? 80, d(start), 8);
    await next(d(start + 1));
    for (const r of perf.pullup ?? [10]) await log("pullup", r, undefined, d(start + 1));
    await next(d(start + 2));
    for (const r of perf.squat ?? [6]) await log("squat", r, 100, d(start + 2), 8);
  };
  return { ...t, push, pull, legs, create, next, log, runCycle };
}

describe("programs", () => {
  test("create builds slots and cycle 1 from the routines' targets", async () => {
    const { create } = await setup();
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body.is_active).toBe(true);
    expect(res.body.slots.map((s: any) => s.routine.name)).toEqual(["Push A", "Pull A", "Legs A"]);
    const c = res.body.current_cycle;
    expect(c).toMatchObject({ number: 1, targets_source: "initial", complete: false, next_slot_position: 1 });
    expect(c.slots[0].exercises[0]).toMatchObject({ rest_seconds: 180, exercise: { id: "bench" } });
    expect(c.slots[0].exercises[0].sets).toHaveLength(2);
    expect(c.slots.map((s: any) => s.status)).toEqual(["pending", "pending", "pending"]);
  });

  test("only one program is active; names are unique; unknown routines 404", async () => {
    const { call, create, push } = await setup();
    const a = await create();
    const b = await call("POST", "/api/programs", { name: "Other", routine_ids: [push.id] });
    expect(b.body.is_active).toBe(true);
    expect((await call("GET", `/api/programs/${a.body.id}`)).body.is_active).toBe(false);
    expect((await call("GET", "/api/programs/current")).body.name).toBe("Other");
    expect((await create()).status).toBe(409);
    expect((await call("POST", "/api/programs", { name: "X", routine_ids: [999] })).status).toBe(404);
    const list = await call("GET", "/api/programs");
    expect(list.body.programs.map((p: any) => [p.name, p.is_active])).toEqual([["Other", true], ["PPL", false]]);
    await call("PATCH", `/api/programs/${a.body.id}`, { active: true });
    expect((await call("GET", "/api/programs/current")).body.name).toBe("PPL");
  });

  test("no active program gives a 404 with a hint", async () => {
    const { call } = await setup();
    const res = await call("POST", "/api/programs/next-workout", {});
    expect(res.status).toBe(404);
    expect(res.body.details.hint).toContain("create_program");
  });
});

describe("next workout", () => {
  test("walks the slots in order and stamps the workout with its cycle and slot", async () => {
    const { create, next, log, call } = await setup();
    await create();
    const a = await next();
    expect(a.body).toMatchObject({ cycle: { number: 1 }, slot: { position: 1, of: 3, routine: { name: "Push A" } }, already_started: false });
    expect(a.body.workout).toMatchObject({ date: "2026-03-10", name: "Push A", status: "planned" });
    expect(a.body.workout.cycle_id).toBeGreaterThan(0);
    expect(a.body.workout.exercises[0].sets[0].target).toMatchObject({ reps_min: 5, reps_max: 8, weight_kg: 80 });

    // Asking again before anything is performed returns the same planned workout.
    const again = await next();
    expect(again.body.already_started).toBe(true);
    expect(again.body.workout.id).toBe(a.body.workout.id);

    // Logging fills the planned set; the slot is then done and the pointer moves on.
    const s = await log("bench", 8, 80, "2026-03-10");
    expect(s.body.filled_planned).toBe(true);
    const status = await call("GET", "/api/programs/current");
    expect(status.body.current_cycle.slots.map((x: any) => x.status)).toEqual(["done", "pending", "pending"]);
    const b = await next("2026-03-12");
    expect(b.body.slot.routine.name).toBe("Pull A");
  });

  test("merges into an ad-hoc workout already on that day", async () => {
    const { create, next, log } = await setup();
    await create();
    await log("squat", 5, 60, "2026-03-10");
    const r = await next();
    expect(r.body.workout.exercises.map((e: any) => e.exercise.id)).toEqual(["squat", "bench"]);
  });

  test("a day that already has a program workout is a 409", async () => {
    const { create, next, log } = await setup();
    await create();
    await next("2026-03-10");
    await log("bench", 8, 80, "2026-03-10");
    expect((await next("2026-03-10")).status).toBe(409);
  });

  test("after a complete cycle, the next one starts with carried-over targets", async () => {
    const { create, next, runCycle, call } = await setup();
    await create();
    await runCycle(11);
    const status = await call("GET", "/api/programs/current");
    expect(status.body.current_cycle.complete).toBe(true);
    expect(status.body.cycles_completed).toBe(1);
    const r = await next("2026-03-15");
    expect(r.body.cycle).toEqual({ number: 2, targets_source: "carried_over" });
    expect(r.body.workout.exercises[0].sets[0].target.weight_kg).toBe(80);
  });
});

describe("skip", () => {
  test("skips the next slot so the cycle can complete; done slots can't be skipped", async () => {
    const { create, next, log, call } = await setup();
    await create();
    await next("2026-03-11");
    await log("bench", 8, 80, "2026-03-11");
    expect((await call("POST", "/api/programs/skip", { slot_position: 1 })).status).toBe(409);
    const s = await call("POST", "/api/programs/skip", {});
    expect(s.body.skipped).toEqual({ position: 2, routine: "Pull A" });
    const r = await next("2026-03-12");
    expect(r.body.slot.routine.name).toBe("Legs A");
    await log("squat", 6, 100, "2026-03-12");
    const status = await call("GET", "/api/programs/current");
    expect(status.body.current_cycle.slots.map((x: any) => x.status)).toEqual(["done", "skipped", "done"]);
    expect(status.body.current_cycle.complete).toBe(true);
  });
});

describe("cycle targets", () => {
  test("partial update creates the next cycle, replaces sets and carries the rest", async () => {
    const { create, runCycle, call, next } = await setup();
    await create();
    await runCycle(11);
    const res = await call("PUT", "/api/programs/cycles/targets", {
      notes: "+2.5 bench, add a set",
      slots: [{ slot_position: 1, exercises: [{ exercise_id: "bench", sets: [{ reps_min: 5, reps_max: 8, weight_kg: 82.5 }, { reps_min: 5, reps_max: 8, weight_kg: 82.5 }, { reps: 5, weight_kg: 82.5, rpe: 9 }] }] }],
    });
    expect(res.status).toBe(200);
    const c = res.body.cycle;
    expect(c).toMatchObject({ number: 2, targets_source: "claude", notes: "+2.5 bench, add a set" });
    expect(c.slots[0].exercises[0].sets.map((s: any) => [s.set_number, s.weight_kg, s.reps_min, s.reps_max])).toEqual([
      [1, 82.5, 5, 8],
      [2, 82.5, 5, 8],
      [3, 82.5, 5, 5],
    ]);
    expect(c.slots[2].exercises[0].sets[0].weight_kg).toBe(100); // squat carried over
    const w = await next("2026-03-15");
    expect(w.body.cycle.number).toBe(2);
    expect(w.body.workout.exercises[0].sets).toHaveLength(3);

    // Sets Claude added survive into the cycle after (carry-over copies the full set list).
    await call("POST", "/api/programs/skip", { slot_position: 2 });
    await call("POST", "/api/programs/skip", { slot_position: 3 });
    await call("POST", "/api/sets", { exercise_id: "bench", reps: 8, weight_kg: 82.5, date: "2026-03-15" });
    const c3 = await next("2026-03-17");
    expect(c3.body.cycle).toEqual({ number: 3, targets_source: "carried_over" });
    expect(c3.body.workout.exercises[0].sets).toHaveLength(3);
  });

  test("mid-cycle, defaults to the current cycle and locks started slots", async () => {
    const { create, next, call } = await setup();
    await create();
    await next("2026-03-11"); // Push A planned: started
    const locked = await call("PUT", "/api/programs/cycles/targets", {
      slots: [{ slot_position: 1, exercises: [{ exercise_id: "bench", sets: [{ reps: 5, weight_kg: 90 }] }] }],
    });
    expect(locked.status).toBe(409);
    const ok = await call("PUT", "/api/programs/cycles/targets", {
      slots: [{ slot_position: 3, exercises: [{ exercise_id: "squat", sets: [{ reps: 5, weight_kg: 105 }] }] }],
    });
    expect(ok.body.cycle).toMatchObject({ number: 1, targets_source: "claude" });
    expect(ok.body.cycle.slots[2].exercises[0].sets[0].weight_kg).toBe(105);
  });

  test("rejects exercises not in the slot's routine, unknown slots and bad cycle numbers", async () => {
    const { create, call } = await setup();
    await create();
    const put = (b: object) => call("PUT", "/api/programs/cycles/targets", b);
    const notInRoutine = await put({ slots: [{ slot_position: 1, exercises: [{ exercise_id: "squat", sets: [{ reps: 5 }] }] }] });
    expect(notInRoutine.status).toBe(400);
    expect(notInRoutine.body.details.exercises).toEqual(["bench"]);
    expect((await put({ slots: [{ slot_position: 9, exercises: [{ exercise_id: "bench", sets: [{ reps: 5 }] }] }] })).status).toBe(400);
    expect((await put({ cycle_number: 5, slots: [{ slot_position: 1, exercises: [{ exercise_id: "bench", sets: [{ reps: 5 }] }] }] })).status).toBe(404);
    expect((await put({ slots: [{ slot_position: 1, exercises: [{ exercise_id: "bench", sets: [{ reps_min: 8, reps_max: 5 }] }] }] })).status).toBe(400);
  });

  test("routine edits appear from the next cycle with default targets", async () => {
    const { create, runCycle, call, push, next } = await setup();
    await create();
    await runCycle(11);
    await call("PATCH", `/api/routines/${push.id}`, {
      exercises: [
        { exercise_id: "bench", sets: [{ reps_min: 5, reps_max: 8, weight_kg: 70 }] },
        { exercise_id: "assisted_dip", sets: [{ reps_min: 8, reps_max: 12, weight_kg: -20 }] },
      ],
    });
    const r = await next("2026-03-15");
    const ex = r.body.workout.exercises.map((e: any) => [e.exercise.id, e.sets.map((s: any) => s.target.weight_kg)]);
    // bench keeps cycle 1's two sets at 80 (carried over), dips arrive with the routine's default.
    expect(ex).toEqual([
      ["bench", [80, 80]],
      ["assisted_dip", [-20]],
    ]);
  });

  test("changing a program's routines is blocked once it has started", async () => {
    const { create, next, call, legs } = await setup();
    const p = await create();
    expect((await call("PATCH", `/api/programs/${p.body.id}`, { routine_ids: [legs.id] })).body.slots).toHaveLength(1);
    await next();
    expect((await call("PATCH", `/api/programs/${p.body.id}`, { routine_ids: [legs.id] })).status).toBe(409);
  });
});

describe("review", () => {
  test("targets vs performed per lift, with e1RM vs the previous cycle", async () => {
    const { create, runCycle, call } = await setup();
    await call("PUT", "/api/bodyweight/2026-03-01", { weight_kg: 80 });
    await create();
    await runCycle(11, { bench: [8, 6] });
    await call("PUT", "/api/bodyweight/2026-03-14", { weight_kg: 81 });
    await runCycle(14, { bench: [8, 8], benchKg: 82.5 });

    const r1 = await call("GET", "/api/programs/cycles/review?cycle_number=1");
    const bench1 = r1.body.slots[0].exercises[0];
    expect(bench1).toMatchObject({ working_target_sets: 2, sets_hit: 2, top_of_range_all_sets: false, avg_rpe: 8, prev_cycle_best_e1rm_kg: null });

    const r2 = await call("GET", "/api/programs/cycles/review");
    expect(r2.body.cycle).toMatchObject({ number: 2, complete: true, targets_source: "carried_over" });
    expect(r2.body.window).toEqual({ from: "2026-03-14", to: "2026-03-16" });
    const bench2 = r2.body.slots[0].exercises[0];
    expect(bench2.top_of_range_all_sets).toBe(true); // 8, 8 at ≥ 80 target
    expect(bench2.best_e1rm_kg).toBe(104.5); // 82.5 × (1 + 8/30)
    expect(bench2.prev_cycle_best_e1rm_kg).toBe(101.3);
    expect(bench2.summary).toContain("(+3.2)");
    // Pull-ups use bodyweight for load.
    expect(r2.body.slots[1].exercises[0].best_e1rm_kg).toBeCloseTo(81 * (1 + 10 / 30), 1);
    expect(r2.body.bodyweight).toEqual({ start_kg: 81, end_kg: 81, change_kg: 0 });
  });

  test("missed targets, skipped slots and ad-hoc workouts in the window", async () => {
    const { create, next, log, call } = await setup();
    await create();
    await next("2026-03-11");
    await log("bench", 4, 80, "2026-03-11"); // below reps_min; second set never done
    await call("POST", "/api/programs/skip", {});
    await call("POST", "/api/sets", { exercise_id: "plank", duration_s: 60, date: "2026-03-12" });
    await next("2026-03-13");
    await log("squat", 6, 100, "2026-03-13");
    const r = await call("GET", "/api/programs/cycles/review");
    const bench = r.body.slots[0].exercises[0];
    expect(bench.sets_hit).toBe(0);
    expect(bench.performed).toHaveLength(1);
    expect(r.body.slots[1]).toMatchObject({ routine: "Pull A", status: "skipped" });
    expect(r.body.adhoc_workouts.map((w: any) => w.date)).toEqual(["2026-03-12"]);
  });

  test("before any cycle is complete, the default review is a 404 listing cycles", async () => {
    const { create, call } = await setup();
    await create();
    const r = await call("GET", "/api/programs/cycles/review");
    expect(r.status).toBe(404);
    expect(r.body.details.cycles).toEqual([{ number: 1, complete: false }]);
  });
});
