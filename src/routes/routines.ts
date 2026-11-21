import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { RoutineInput, RoutinePatch, StartRoutineInput } from "../schemas.ts";
import { createRoutine, deleteRoutine, getRoutine, listRoutines, startRoutine, updateRoutine } from "../services/routines.ts";

const Id = z.coerce.number().int().positive();

export const routineRoutes = new Hono<AppEnv>()
  .get("/", (c) => c.json({ routines: listRoutines(c.var.ctx) }))
  .post("/", async (c) => c.json(createRoutine(c.var.ctx, RoutineInput.parse(await c.req.json())), 201))
  .get("/:id", (c) => c.json(getRoutine(c.var.ctx, Id.parse(c.req.param("id")))))
  .patch("/:id", async (c) =>
    c.json(updateRoutine(c.var.ctx, Id.parse(c.req.param("id")), RoutinePatch.parse(await c.req.json()))),
  )
  .delete("/:id", (c) => c.json(deleteRoutine(c.var.ctx, Id.parse(c.req.param("id")))))
  .post("/:id/start", async (c) => {
    const { date } = StartRoutineInput.parse(await c.req.json().catch(() => ({})));
    return c.json(startRoutine(c.var.ctx, Id.parse(c.req.param("id")), date), 201);
  });
