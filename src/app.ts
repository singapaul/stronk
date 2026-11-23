import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { ZodError } from "zod";
import { createRateLimiter, ingestAuth, mcpAuth, rateLimit, restAuth, type Credential } from "./auth.ts";
import { mcpHandler } from "./mcp/route.ts";
import { swaggerUI } from "@hono/swagger-ui";
import { buildOpenApi } from "./openapi/build.ts";
import type { DB } from "./db.ts";
import { devLoginEmail, webAuthConfig, type Env } from "./env.ts";
import { randomBytes } from "node:crypto";
import { readSession, webAuthRoutes, type WebAuthDeps } from "./web-auth.ts";
import { webApp } from "./web-static.ts";
import { AppError } from "./errors.ts";
import { exerciseRoutes } from "./routes/exercises.ts";
import { setRoutes } from "./routes/sets.ts";
import { routineRoutes } from "./routes/routines.ts";
import { bodyweightRoutes, importBodyweightHandler } from "./routes/body.ts";
import { statsRoutes } from "./routes/stats.ts";
import { programRoutes } from "./routes/programs.ts";
import { blockRoutes, workoutRoutes } from "./routes/workouts.ts";
import { systemClock, type Clock } from "./services/dates.ts";

export type AppDeps = { db: DB; env: Env; clock?: Clock; log?: boolean; fetch?: typeof fetch; webDist?: string };
export type Ctx = { db: DB; clock: Clock };
export type AppEnv = { Variables: { ctx: Ctx; credential: Credential } };

export function createApp({ db, env, clock = systemClock, log = false, fetch: fetchFn = fetch, webDist }: AppDeps) {
  const app = new Hono<AppEnv>();
  const ctx: Ctx = { db, clock };
  const limiter = createRateLimiter({ max: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW_S * 1000, clock });
  const webConfig = webAuthConfig(env);
  const devEmail = devLoginEmail(env);
  const web: WebAuthDeps = {
    config: webConfig,
    // Dev sign-in without Google config signs with a per-process secret (sessions end on restart).
    sessionSecret: webConfig?.sessionSecret ?? (devEmail ? randomBytes(32).toString("hex") : null),
    devEmail,
    clock,
    fetch: fetchFn,
  };
  const session = (c: Parameters<typeof readSession>[0]) => readSession(c, web);

  if (log) {
    // Never write the secret MCP path token to logs.
    app.use("*", logger((line) => console.log(line.replaceAll(env.MCP_PATH_TOKEN, "<redacted>"))));
  }
  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // Phone health sync. Registered before the /api/* auth so INGEST_TOKEN works here (and only here).
  app.post("/api/bodyweight/import", rateLimit(limiter), ingestAuth(env), importBodyweightHandler);

  app.use("/api/*", rateLimit(limiter), restAuth(env, session));
  app.route("/api/exercises", exerciseRoutes);
  app.route("/api/workouts", workoutRoutes);
  app.route("/api/workout-exercises", blockRoutes);
  app.route("/api/sets", setRoutes);
  app.route("/api/routines", routineRoutes);
  app.route("/api/bodyweight", bodyweightRoutes);
  app.route("/api", statsRoutes);
  app.route("/api/programs", programRoutes);

  // API docs: Swagger UI and the generated OpenAPI spec, behind the same basic auth as /api.
  app.use("/docs", rateLimit(limiter), restAuth(env, session));
  app.use("/openapi.json", rateLimit(limiter), restAuth(env, session));
  app.get("/openapi.json", async (c) => c.json(await buildOpenApi(ctx)));
  // Scheme-relative spec URL: a relative one breaks when the page was opened as https://user:pass@host/docs
  // (browsers refuse fetch() against a base URL that carries credentials).
  app.get("/docs", (c, next) => {
    // The Host header is interpolated into the page, so only accept a plain host[:port].
    const host = c.req.header("host") ?? "";
    const specUrl = /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `//${host}/openapi.json` : "/openapi.json";
    const ui = swaggerUI({ url: specUrl, title: "stronk API", persistAuthorization: true });
    // swaggerUI is typed for Hono's default Env; it only renders HTML, so our AppEnv context is safe to pass.
    return ui(c as unknown as Parameters<typeof ui>[0], next);
  });

  // Web app sign-in (Google, plus a dev shortcut outside production).
  app.use("/auth/*", rateLimit(limiter));
  app.route("/auth", webAuthRoutes(web));

  // MCP: Bearer or Basic on /mcp; secret path for clients that can't send headers.
  app.all("/mcp", rateLimit(limiter), mcpAuth(env), mcpHandler);
  app.all("/mcp/:token", rateLimit(limiter), mcpAuth(env), mcpHandler);

  // The web app (static build + client-side routes). Registered last so every API route wins.
  app.use("*", webApp(webDist));

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
