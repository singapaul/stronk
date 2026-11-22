import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { CustomExerciseInput, ExercisePatch, ExerciseSearchQuery } from "../schemas.ts";
import { createCustomExercise, getExercise, searchExercises, updateExercise } from "../services/exercises.ts";

export const exerciseRoutes = new Hono<AppEnv>()
  .get("/", (c) => {
    const { q, ...rest } = ExerciseSearchQuery.parse(c.req.query());
    return c.json(searchExercises(c.var.ctx.db, { ...rest, query: q }));
  })
  .get("/:id", (c) => c.json(getExercise(c.var.ctx.db, c.req.param("id"))))
  .post("/", async (c) => {
    const input = CustomExerciseInput.parse(await c.req.json());
    return c.json(createCustomExercise(c.var.ctx.db, input), 201);
  })
  .patch("/:id", async (c) => {
    const patch = ExercisePatch.parse(await c.req.json());
    return c.json(updateExercise(c.var.ctx.db, c.req.param("id"), patch));
  });
