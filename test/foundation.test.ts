import { describe, expect, test } from "bun:test";
import { migrate } from "../src/db.ts";
import { loadEnv } from "../src/env.ts";
import { addDays, deriveStatus, trainingDay } from "../src/services/dates.ts";
import { testApp, testDb } from "./helpers.ts";

describe("migrations", () => {
  test("apply once and are idempotent", () => {
    const db = testDb();
    expect(migrate(db)).toEqual([]);
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(["exercises", "workouts", "workout_exercises", "sets", "routines", "body_measurements"]),
    );
  });

  test("foreign keys are enforced", () => {
    const db = testDb();
    expect(() => db.run("INSERT INTO workout_exercises (workout_id, exercise_id, position) VALUES (999, 'x', 1)")).toThrow();
  });

  test("updated_at triggers bump the parent workout", async () => {
    const db = testDb();
    db.run("INSERT INTO exercises (id, name) VALUES ('ex', 'Ex')");
    db.run("INSERT INTO workouts (id, date, updated_at) VALUES (1, '2026-01-01', '2000-01-01T00:00:00.000Z')");
    db.run("INSERT INTO workout_exercises (id, workout_id, exercise_id, position) VALUES (1, 1, 'ex', 1)");
    const w = db.query<{ updated_at: string }, []>("SELECT updated_at FROM workouts WHERE id = 1").get()!;
    expect(w.updated_at > "2000-01-01").toBe(true);
  });

  test("fts index follows exercise rows", () => {
    const db = testDb();
    db.run(`INSERT INTO exercises (id, name, primary_muscles) VALUES ('a', 'Barbell Bench Press', '["chest"]')`);
    const hit = db.query("SELECT rowid FROM exercises_fts WHERE exercises_fts MATCH 'bench'").all();
    expect(hit.length).toBe(1);
    db.run("UPDATE exercises SET name = 'Squat' WHERE id = 'a'");
    expect(db.query("SELECT rowid FROM exercises_fts WHERE exercises_fts MATCH 'bench'").all().length).toBe(0);
  });
});

describe("env", () => {
  const good = { BASIC_AUTH_USER: "u", BASIC_AUTH_PASS: "p", MCP_TOKEN: "a".repeat(32), MCP_PATH_TOKEN: "b".repeat(32) };

  test("accepts a complete env with defaults", () => {
    const env = loadEnv(good);
    expect(env.PORT).toBe(3000);
    expect(env.DB_PATH).toBe("./data/gym.db");
  });

  test("refuses missing auth vars", () => {
    expect(() => loadEnv({ ...good, BASIC_AUTH_PASS: undefined })).toThrow(/BASIC_AUTH_PASS/);
  });

  test("refuses short tokens", () => {
    expect(() => loadEnv({ ...good, MCP_TOKEN: "short" })).toThrow(/at least 32/);
  });

  test("refuses identical tokens", () => {
    expect(() => loadEnv({ ...good, MCP_PATH_TOKEN: good.MCP_TOKEN })).toThrow(/must differ/);
  });
});

describe("dates", () => {
  test("training day rolls over at 04:00 London", () => {
    // Winter (GMT): 01:30 UTC = 01:30 London → still previous day.
    expect(trainingDay(new Date("2026-01-15T01:30:00Z"))).toBe("2026-01-14");
    expect(trainingDay(new Date("2026-01-15T04:00:00Z"))).toBe("2026-01-15");
    // Summer (BST): 03:30 UTC = 04:30 London → new day.
    expect(trainingDay(new Date("2026-07-15T03:30:00Z"))).toBe("2026-07-15");
    expect(trainingDay(new Date("2026-07-15T02:30:00Z"))).toBe("2026-07-14");
  });

  test("addDays crosses month ends", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-03-01", -14)).toBe("2026-02-15");
  });

  test("status is derived from date and performed sets", () => {
    expect(deriveStatus("2026-03-10", "2026-03-10", 0)).toBe("planned");
    expect(deriveStatus("2026-03-10", "2026-03-10", 3)).toBe("in_progress");
    expect(deriveStatus("2026-03-09", "2026-03-10", 3)).toBe("completed");
  });
});

describe("http", () => {
  test("/health is open", async () => {
    const { app } = testApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("unknown server routes return JSON 404 (other paths belong to the web app)", async () => {
    const { app } = testApp();
    const res = await app.request("/auth/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});
