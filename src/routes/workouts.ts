import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { BlockPatch, CreateWorkoutInput, IsoDate, PlanSessionInput, WorkoutListInput, WorkoutPatch } from "../schemas.ts";
import {
  deleteWorkout,
  getWorkout,
  getWorkoutByDate,
  listWorkouts,
  logWorkout,
  planSession,
  today,
  updateBlock,
  updateWorkout,
  workoutPrs,
} from "../services/workouts.ts";
import { notFound } from "../errors.ts";

const Id = z.coerce.number().int().positive();

export const workoutRoutes = new Hono<AppEnv>()
  .get("/", (c) => c.json({ workouts: listWorkouts(c.var.ctx, WorkoutListInput.parse(c.req.query())) }))
  .post("/", async (c) => {
    const input = CreateWorkoutInput.parse(await c.req.json());
    return c.json(logWorkout(c.var.ctx, input), 201);
  })
  .post("/plan", async (c) => {
    const input = PlanSessionInput.parse(await c.req.json());
    return c.json(planSession(c.var.ctx, input), 201);
  })
  .get("/today", (c) => {
    const date = today(c.var.ctx);
    const w = getWorkoutByDate(c.var.ctx, date);
    if (!w) throw notFound(`Workout for ${date}`);
    return c.json(w);
  })
  .get("/by-date/:date", (c) => {
    const date = IsoDate.parse(c.req.param("date"));
    const w = getWorkoutByDate(c.var.ctx, date);
    if (!w) throw notFound(`Workout for ${date}`);
    return c.json(w);
  })
  .get("/:id/prs", (c) => c.json(workoutPrs(c.var.ctx, Id.parse(c.req.param("id")))))
  .get("/:id", (c) => c.json(getWorkout(c.var.ctx, Id.parse(c.req.param("id")))))
  .patch("/:id", async (c) =>
    c.json(updateWorkout(c.var.ctx, Id.parse(c.req.param("id")), WorkoutPatch.parse(await c.req.json()))),
  )
  .delete("/:id", (c) => c.json(deleteWorkout(c.var.ctx, Id.parse(c.req.param("id")))));

export const blockRoutes = new Hono<AppEnv>().patch("/:id", async (c) =>
  c.json(updateBlock(c.var.ctx, Id.parse(c.req.param("id")), BlockPatch.parse(await c.req.json()))),
);
