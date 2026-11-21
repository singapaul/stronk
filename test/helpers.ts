import { migrate, openDb } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import { createApp } from "../src/app.ts";

export const testEnv: Env = {
  BASIC_AUTH_USER: "lifter",
  BASIC_AUTH_PASS: "hunter2",
  MCP_TOKEN: "t".repeat(40),
  MCP_PATH_TOKEN: "p".repeat(40),
  DB_PATH: ":memory:",
  PORT: 0,
  RATE_LIMIT_MAX: 10_000,
  RATE_LIMIT_WINDOW_S: 300,
};

/** Fresh in-memory DB with migrations applied. */
export function testDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

/** A settable clock. Default 2026-03-10 18:00 London (UTC in March). */
export function testClock(iso = "2026-03-10T18:00:00Z") {
  let now = new Date(iso);
  const clock = () => new Date(now);
  clock.set = (next: string) => {
    now = new Date(next);
  };
  return clock;
}

export function testApp(opts: { env?: Partial<Env>; clock?: ReturnType<typeof testClock> } = {}) {
  const db = testDb();
  const clock = opts.clock ?? testClock();
  const env = { ...testEnv, ...opts.env };
  const { app, ctx } = createApp({ db, env, clock });
  const auth = { authorization: `Basic ${btoa(`${env.BASIC_AUTH_USER}:${env.BASIC_AUTH_PASS}`)}` };
  /** Authenticated JSON request helper. */
  const call = async <T = any>(method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { ...auth, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  return { app, db, clock, env, ctx, auth, call };
}

/** A handful of exercises, enough for logging tests without seeding the full library. */
export function seedMini(db: ReturnType<typeof testDb>) {
  const ins = db.query(
    "INSERT INTO exercises (id, name, type, equipment, primary_muscles, secondary_muscles) VALUES (?, ?, ?, ?, ?, ?)",
  );
  ins.run("bench", "Barbell Bench Press", "weight_reps", "barbell", '["chest"]', '["triceps","shoulders"]');
  ins.run("squat", "Barbell Squat", "weight_reps", "barbell", '["quadriceps"]', '["glutes","hamstrings"]');
  ins.run("pullup", "Pullups", "bodyweight_reps", "body only", '["lats"]', '["biceps"]');
  ins.run("assisted_dip", "Assisted Dip", "bodyweight_assisted_reps", "machine", '["triceps"]', '["chest"]');
  ins.run("plank", "Plank", "duration", "body only", '["abdominals"]', "[]");
}
