import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { NextWorkoutInput, ProgramInput, ProgramPatch, ReviewCycleQuery, SetCycleTargetsInput, SkipSlotInput } from "../schemas.ts";
import {
  createProgram,
  getProgram,
  listPrograms,
  reviewCycle,
  setCycleTargets,
  skipSlot,
  startNextWorkout,
  updateProgram,
} from "../services/programs.ts";

const Id = z.coerce.number().int().positive();
const body = async (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => ({}));

// Static paths are registered before /:id so they win.
export const programRoutes = new Hono<AppEnv>()
  .get("/", (c) => c.json({ programs: listPrograms(c.var.ctx) }))
  .post("/", async (c) => c.json(createProgram(c.var.ctx, ProgramInput.parse(await c.req.json())), 201))
  .get("/current", (c) => c.json(getProgram(c.var.ctx)))
  .post("/next-workout", async (c) => c.json(startNextWorkout(c.var.ctx, NextWorkoutInput.parse(await body(c)))))
  .post("/skip", async (c) => c.json(skipSlot(c.var.ctx, SkipSlotInput.parse(await body(c)))))
  .get("/cycles/review", (c) => c.json(reviewCycle(c.var.ctx, ReviewCycleQuery.parse(c.req.query()))))
  .put("/cycles/targets", async (c) => c.json(setCycleTargets(c.var.ctx, SetCycleTargetsInput.parse(await c.req.json()))))
  .get("/:id", (c) => c.json(getProgram(c.var.ctx, Id.parse(c.req.param("id")))))
  .patch("/:id", async (c) => c.json(updateProgram(c.var.ctx, Id.parse(c.req.param("id")), ProgramPatch.parse(await c.req.json()))));
