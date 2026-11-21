import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { CustomExerciseInput, ExercisePatch, ExerciseSearchInput } from "../schemas.ts";
import { createCustomExercise, getExercise, searchExercises, updateExercise } from "../services/exercises.ts";

export const exerciseRoutes = new Hono<AppEnv>()
  .get("/", (c) => {
    // REST uses ?q= for the free-text query.
    const { q, ...rest } = c.req.query();
    const input = ExerciseSearchInput.parse({ ...rest, query: q ?? rest.query });
    return c.json(searchExercises(c.var.ctx.db, input));
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
