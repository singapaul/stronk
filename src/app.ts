import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import type { DB } from "./db.ts";
import type { Env } from "./env.ts";
import { AppError } from "./errors.ts";
import { systemClock, type Clock } from "./services/dates.ts";

export type AppDeps = { db: DB; env: Env; clock?: Clock };
export type Ctx = { db: DB; clock: Clock };
export type AppEnv = { Variables: { ctx: Ctx } };

export function createApp({ db, env, clock = systemClock }: AppDeps) {
  const app = new Hono<AppEnv>();
  const ctx: Ctx = { db, clock };

  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: err.message, details: err.details }, err.status);
    if (err instanceof ZodError) return c.json({ error: "Validation failed", details: err.issues }, 400);
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });

  void env;
  return app;
}
