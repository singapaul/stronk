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
  const app = createApp({ db, env, clock });
  return { app, db, clock, env };
}
