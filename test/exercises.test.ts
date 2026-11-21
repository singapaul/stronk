import { beforeAll, describe, expect, test } from "bun:test";
import { deriveType, loadSourceExercises, seedExercises, type SourceExercise } from "../src/seed.ts";
import { searchExercises, updateExercise, IMAGE_BASE } from "../src/services/exercises.ts";
import { testApp, testDb } from "./helpers.ts";

let source: SourceExercise[];
beforeAll(async () => {
  source = await loadSourceExercises();
});

const count = (db: ReturnType<typeof testDb>, where = "1") =>
  db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM exercises WHERE ${where}`).get()!.n;

describe("seed", () => {
  test("vendored dataset matches the expected shape", () => {
    expect(source.length).toBeGreaterThan(800);
    expect(Object.keys(source[0]!).sort()).toEqual(
      ["category", "equipment", "force", "id", "images", "instructions", "level", "mechanic", "name", "primaryMuscles", "secondaryMuscles"],
    );
  });

  test("is idempotent", () => {
    const db = testDb();
    expect(seedExercises(db, source).inserted).toBe(source.length);
    expect(seedExercises(db, source).inserted).toBe(0);
    expect(count(db)).toBe(source.length);
  });

  test("refresh updates library rows but keeps custom rows and type overrides", () => {
    const db = testDb();
    seedExercises(db, source);
    db.run(`INSERT INTO exercises (id, name, primary_muscles, is_custom) VALUES ('custom_x', 'Mine', '["chest"]', 1)`);
    const bench = "Barbell_Bench_Press_-_Medium_Grip";
    updateExercise(db, "Plank", { type: "bodyweight_reps" });
    db.run(`UPDATE exercises SET name = 'stale' WHERE id = '${bench}'`);

    seedExercises(db, source, { refresh: true });

    const row = (id: string) => db.query<{ name: string; type: string }, [string]>("SELECT name, type FROM exercises WHERE id = ?").get(id)!;
    expect(row(bench).name).toBe("Barbell Bench Press - Medium Grip");
    expect(row("Plank").type).toBe("bodyweight_reps");
    expect(row("custom_x").name).toBe("Mine");
    expect(count(db)).toBe(source.length + 1);
  });

  test("derives exercise types", () => {
    const byId = (id: string) => deriveType(source.find((e) => e.id === id)!);
    expect(byId("Barbell_Bench_Press_-_Medium_Grip")).toBe("weight_reps");
    expect(byId("Plank")).toBe("duration");
    expect(byId("Pullups")).toBe("bodyweight_reps");
    const types = new Set(source.map(deriveType));
    expect(types.has("distance_duration")).toBe(true);
  });
});

describe("search", () => {
  const db = testDb();
  beforeAll(() => {
    seedExercises(db, source);
  });

  test("finds by name prefix words", () => {
    const { results } = searchExercises(db, { query: "bench press", limit: 10, offset: 0 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => /bench/i.test(r.name) || /bench/i.test(r.id))).toBe(true);
  });

  test("filters by muscle and equipment", () => {
    const { results } = searchExercises(db, { muscle: "lats", equipment: "cable", limit: 50, offset: 0 });
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.primary_muscles).toContain("lats");
      expect(r.equipment).toBe("cable");
    }
  });

  test("loosens to OR when no exercise matches every word", () => {
    const { results } = searchExercises(db, { query: "bench zzzqqq", limit: 5, offset: 0 });
    expect(results.length).toBeGreaterThan(0);
  });

  test("survives FTS syntax in user input", () => {
    expect(() => searchExercises(db, { query: 'squat" OR NEAR(', limit: 5, offset: 0 })).not.toThrow();
  });

  test("ranks exercises I've logged first", () => {
    const pick = "Bench_Press_-_Powerlifting";
    db.run("INSERT INTO workouts (id, date) VALUES (1, '2026-01-01')");
    db.run(`INSERT INTO workout_exercises (id, workout_id, exercise_id, position) VALUES (1, 1, '${pick}', 1)`);
    db.run("INSERT INTO sets (workout_exercise_id, set_number, reps, weight_kg) VALUES (1, 1, 5, 100)");
    const { results } = searchExercises(db, { query: "bench", limit: 5, offset: 0 });
    expect(results[0]!.id).toBe(pick);
    expect(results[0]!.times_logged).toBe(1);
  });
});

describe("REST /api/exercises", () => {
  const setup = () => {
    const t = testApp();
    seedExercises(t.db, source);
    return t;
  };

  test("requires auth", async () => {
    const { app } = setup();
    expect((await app.request("/api/exercises")).status).toBe(401);
  });

  test("GET search with ?q", async () => {
    const { call } = setup();
    const { status, body } = await call("GET", "/api/exercises?q=deadlift&limit=3");
    expect(status).toBe(200);
    expect(body.results.length).toBe(3);
    expect(body.total).toBeGreaterThan(3);
  });

  test("GET detail builds image URLs", async () => {
    const { call } = setup();
    const { body } = await call("GET", "/api/exercises/Barbell_Bench_Press_-_Medium_Grip");
    expect(body.images[0].startsWith(IMAGE_BASE)).toBe(true);
    expect(body.instructions.length).toBeGreaterThan(0);
  });

  test("unknown id 404s with suggestions", async () => {
    const { call } = setup();
    const { status, body } = await call("GET", "/api/exercises/Barbell_Bench_Pres");
    expect(status).toBe(404);
    expect(body.details.suggestions.length).toBeGreaterThan(0);
    expect(body.details.suggestions.length).toBeLessThanOrEqual(5);
  });

  test("POST creates custom exercise; duplicate is 409", async () => {
    const { call } = setup();
    const input = { name: "Belt Squat", primary_muscles: ["Quadriceps"], equipment: "machine" };
    const res = await call("POST", "/api/exercises", input);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("custom_belt_squat");
    expect(res.body.is_custom).toBe(true);
    expect(res.body.primary_muscles).toEqual(["quadriceps"]);
    expect((await call("POST", "/api/exercises", input)).status).toBe(409);
  });

  test("POST validates input", async () => {
    const { call } = setup();
    expect((await call("POST", "/api/exercises", { name: "x" })).status).toBe(400);
  });

  test("PATCH on a library exercise only allows type", async () => {
    const { call } = setup();
    expect((await call("PATCH", "/api/exercises/Plank", { name: "Nope" })).status).toBe(409);
    const ok = await call("PATCH", "/api/exercises/Plank", { type: "weight_duration" });
    expect(ok.status).toBe(200);
    expect(ok.body.type).toBe("weight_duration");
  });
});
