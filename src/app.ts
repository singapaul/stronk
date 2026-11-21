import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { ZodError } from "zod";
import { createRateLimiter, rateLimit, restAuth, type Credential } from "./auth.ts";
import type { DB } from "./db.ts";
import type { Env } from "./env.ts";
import { AppError } from "./errors.ts";
import { exerciseRoutes } from "./routes/exercises.ts";
import { setRoutes } from "./routes/sets.ts";
import { routineRoutes } from "./routes/routines.ts";
import { bodyweightRoutes } from "./routes/body.ts";
import { statsRoutes } from "./routes/stats.ts";
import { blockRoutes, workoutRoutes } from "./routes/workouts.ts";
import { systemClock, type Clock } from "./services/dates.ts";

export type AppDeps = { db: DB; env: Env; clock?: Clock; log?: boolean };
export type Ctx = { db: DB; clock: Clock };
export type AppEnv = { Variables: { ctx: Ctx; credential: Credential } };

export function createApp({ db, env, clock = systemClock, log = false }: AppDeps) {
  const app = new Hono<AppEnv>();
  const ctx: Ctx = { db, clock };
  const limiter = createRateLimiter({ max: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW_S * 1000, clock });

  if (log) {
    // Never write the secret MCP path token to logs.
    app.use("*", logger((line) => console.log(line.replaceAll(env.MCP_PATH_TOKEN, "<redacted>"))));
  }
  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.use("/api/*", rateLimit(limiter), restAuth(env));
  app.route("/api/exercises", exerciseRoutes);
  app.route("/api/workouts", workoutRoutes);
  app.route("/api/workout-exercises", blockRoutes);
  app.route("/api/sets", setRoutes);
  app.route("/api/routines", routineRoutes);
  app.route("/api/bodyweight", bodyweightRoutes);
  app.route("/api", statsRoutes);

  app.notFound((c) => c.json({ error: "Not found" }, 404));
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: err.message, details: err.details }, err.status);
    if (err instanceof ZodError) return c.json({ error: "Validation failed", details: err.issues }, 400);
    if (err instanceof SyntaxError) return c.json({ error: "Invalid JSON body" }, 400);
    if (err instanceof HTTPException) return err.getResponse();
    console.error(err);
    return c.json({ error: "Internal server error" }, 500);
  });

  return { app, limiter, ctx };
}
