import { createApp } from "../app.ts";
import { migrate, openDb } from "../db.ts";
import type { Env } from "../env.ts";
import { loadSourceExercises, seedExercises } from "../seed.ts";

/**
 * A scripted session against a fresh in-memory app that hits every documented route once.
 * `bun run docs:examples` saves the responses to examples.json; a test replays it to check the
 * committed examples still match what the API returns.
 */

const ENV: Env = {
  BASIC_AUTH_USER: "docs",
  BASIC_AUTH_PASS: "docs",
  MCP_TOKEN: "x".repeat(32),
  MCP_PATH_TOKEN: "y".repeat(32),
  DB_PATH: ":memory:",
  PORT: 0,
  RATE_LIMIT_MAX: 100_000,
  RATE_LIMIT_WINDOW_S: 300,
};

const DB_TIMESTAMPS = new Set(["created_at", "updated_at"]);

/**
 * Keep examples readable and stable: long arrays are cut to their first two items, and
 * DB-generated timestamps (SQLite's real clock) are pinned so regenerating doesn't churn the file.
 */
function trim(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 2).map(trim);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, DB_TIMESTAMPS.has(k) && typeof v === "string" ? "2026-03-10T18:00:00.000Z" : trim(v)]),
    );
  }
  return value;
}

export async function runExampleScenario(): Promise<Record<string, unknown>> {
  const db = openDb(":memory:");
  migrate(db);
  seedExercises(db, await loadSourceExercises());
  let now = new Date("2026-03-10T18:00:00Z");
  const { app } = createApp({ db, env: ENV, clock: () => new Date(now) });
  const auth = `Basic ${btoa("docs:docs")}`;
  const out: Record<string, unknown> = {};

  /** `key` is the documented route ("METHOD /api/x/:id"); `url` is the concrete request. */
  const call = async (key: string, url: string, body?: unknown, record = true) => {
    const [method] = key.split(" ");
    const res = await app.request(url, {
      method,
      headers: { authorization: auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (res.status >= 400) throw new Error(`${key} → ${res.status}: ${JSON.stringify(json)}`);
    if (record) out[key] = trim(json);
    return json as any;
  };

  const bench = "Barbell_Bench_Press_-_Medium_Grip";
  const squat = "Barbell_Squat";

  await call("GET /api/exercises", "/api/exercises?q=bench%20press&limit=2");
  await call("GET /api/exercises/:id", `/api/exercises/${bench}`);
  const custom = await call("POST /api/exercises", "/api/exercises", { name: "Belt Squat", primary_muscles: ["quadriceps"], equipment: "machine" });
  await call("PATCH /api/exercises/:id", `/api/exercises/${custom.id}`, { level: "intermediate" });

  await call("PUT /api/bodyweight/:date", "/api/bodyweight/2026-03-01", { weight_kg: 82.4 });
  await call("POST /api/bodyweight/import", "/api/bodyweight/import", {
    weight: [
      { time: "2026-03-02T07:12:00Z", kilograms: 82.15 },
      { time: "2026-03-03T07:05:00+00:00", kilograms: 82.0 },
    ],
    body_fat: [{ time: "2026-03-03T07:05:00Z", percentage: 18.2 }],
  });
  await call("POST /api/workouts", "/api/workouts", {
    date: "2026-03-07",
    name: "Lower",
    start_time: "2026-03-07T10:00:00Z",
    end_time: "2026-03-07T11:00:00Z",
    exercises: [{ exercise_id: squat, sets: [{ type: "warmup", reps: 5, weight_kg: 60 }, { reps: 5, weight_kg: 120, rpe: 8 }] }],
  });

  const routine = await call("POST /api/routines", "/api/routines", {
    name: "Push A",
    exercises: [{ exercise_id: bench, rest_seconds: 180, sets: [{ reps_min: 5, reps_max: 8, weight_kg: 80 }, { reps_min: 5, reps_max: 8, weight_kg: 80 }] }],
  });
  await call("GET /api/routines", "/api/routines");
  await call("PATCH /api/routines/:id", `/api/routines/${routine.id}`, { notes: "Heavy day" });
  const started = await call("POST /api/routines/:id/start", `/api/routines/${routine.id}/start`, {});

  // Log the first planned set; it fills the routine's target and reports the next one.
  const logged = await call("POST /api/sets", "/api/sets", { exercise_id: bench, reps: 7, weight_kg: 80, rpe: 8 });
  const plannedId = started.exercises[0].sets[1].id;
  now = new Date("2026-03-10T18:06:00Z");
  await call("POST /api/sets/:id/complete", `/api/sets/${plannedId}/complete`, { reps: 6, weight_kg: 80, rpe: 9 });
  await call("PATCH /api/sets/:id", `/api/sets/${logged.set.id}`, { notes: "paused reps" });
  await call("POST /api/sets/:id/uncomplete", `/api/sets/${plannedId}/uncomplete`);
  await call("POST /api/sets/:id/complete", `/api/sets/${plannedId}/complete`, { reps: 6, weight_kg: 80, rpe: 9 }, false);

  await call("POST /api/workouts/plan", "/api/workouts/plan", {
    date: "2026-03-12",
    name: "Lower B",
    exercises: [{ exercise_id: squat, sets: [{ reps_min: 5, reps_max: 6, weight_kg: 122.5 }] }],
  });
  await call("GET /api/workouts", "/api/workouts?limit=2");
  await call("GET /api/workouts/today", "/api/workouts/today");
  await call("GET /api/workouts/by-date/:date", "/api/workouts/by-date/2026-03-07");
  await call("GET /api/workouts/:id", `/api/workouts/${started.id}`);
  await call("GET /api/workouts/:id/prs", `/api/workouts/${started.id}/prs`);
  await call("PATCH /api/workouts/:id", `/api/workouts/${started.id}`, { notes: "Felt strong" });
  await call("PATCH /api/workout-exercises/:id", `/api/workout-exercises/${started.exercises[0].block_id}`, { rest_seconds: 150 });

  await call("GET /api/exercises/:id/history", `/api/exercises/${bench}/history?limit=2`);
  await call("GET /api/prs", "/api/prs");
  await call("GET /api/summary", "/api/summary");
  await call("GET /api/recent", "/api/recent?days=7");
  await call("GET /api/bodyweight", "/api/bodyweight");

  // Programs: two routines on repeat, one full cycle, then the next cycle's targets.
  const lower = await call("POST /api/routines", "/api/routines", {
    name: "Lower A",
    exercises: [{ exercise_id: squat, rest_seconds: 180, sets: [{ reps_min: 5, reps_max: 6, weight_kg: 120 }, { reps_min: 5, reps_max: 6, weight_kg: 120 }] }],
  }, false);
  const program = await call("POST /api/programs", "/api/programs", { name: "Upper/Lower", routine_ids: [routine.id, lower.id] });
  await call("GET /api/programs/current", "/api/programs/current");
  await call("POST /api/programs/next-workout", "/api/programs/next-workout", { date: "2026-03-13" });
  for (const reps of [8, 8]) await call("POST /api/sets", "/api/sets", { exercise_id: bench, reps, weight_kg: 80, rpe: 8, date: "2026-03-13" }, false);
  await call("POST /api/programs/next-workout", "/api/programs/next-workout", { date: "2026-03-14" }, false);
  for (const reps of [6, 5]) await call("POST /api/sets", "/api/sets", { exercise_id: squat, reps, weight_kg: 120, rpe: 8.5, date: "2026-03-14" }, false);
  await call("GET /api/programs/cycles/review", "/api/programs/cycles/review");
  await call("PUT /api/programs/cycles/targets", "/api/programs/cycles/targets", {
    notes: "Bench hit the top of the range on every set: +2.5 kg",
    slots: [{ slot_position: 1, exercises: [{ exercise_id: bench, sets: [{ reps_min: 5, reps_max: 8, weight_kg: 82.5 }, { reps_min: 5, reps_max: 8, weight_kg: 82.5 }] }] }],
  });
  await call("GET /api/programs", "/api/programs");
  await call("PATCH /api/programs/:id", `/api/programs/${program.id}`, { notes: "4-day split" });
  await call("POST /api/programs/skip", "/api/programs/skip", { slot_position: 2 });
  await call("GET /api/programs/:id", `/api/programs/${program.id}`);

  // Deletions last.
  const extra = await call("POST /api/sets", "/api/sets", { exercise_id: squat, reps: 3, weight_kg: 100, date: "2026-03-07" }, false);
  await call("DELETE /api/sets/:id", `/api/sets/${extra.set.id}`);
  await call("DELETE /api/bodyweight/:date", "/api/bodyweight/2026-03-01");
  const throwaway = await call("POST /api/workouts", "/api/workouts", { date: "2026-02-01" }, false);
  await call("DELETE /api/workouts/:id", `/api/workouts/${throwaway.workout.id}`);
  const tmpRoutine = await call("POST /api/routines", "/api/routines", { name: "Temp", exercises: [{ exercise_id: squat, sets: [{ reps: 5 }] }] }, false);
  await call("DELETE /api/routines/:id", `/api/routines/${tmpRoutine.id}`);
  await call("GET /api/routines/:id", `/api/routines/${routine.id}`);

  return out;
}
