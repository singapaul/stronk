import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { HistoryInput, RecentInput, SummaryInput } from "../schemas.ts";
import { exerciseHistory, personalRecords, recentWorkouts, summary } from "../services/stats.ts";

export const statsRoutes = new Hono<AppEnv>()
  .get("/exercises/:id/history", (c) =>
    c.json(exerciseHistory(c.var.ctx, c.req.param("id"), HistoryInput.parse(c.req.query()))),
  )
  .get("/prs", (c) => c.json(personalRecords(c.var.ctx, c.req.query("exercise_id") || undefined)))
  .get("/summary", (c) => c.json(summary(c.var.ctx, SummaryInput.parse(c.req.query()))))
  .get("/recent", (c) => c.json(recentWorkouts(c.var.ctx, RecentInput.parse(c.req.query()).days)));
