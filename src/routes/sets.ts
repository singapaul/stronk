import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app.ts";
import { CompletePlannedSetInput, CompleteSetBody, LogSetInput, SetPatch } from "../schemas.ts";
import { completePlannedSet, deleteSet, logSet, uncompleteSet, updateSet } from "../services/workouts.ts";

const Id = z.coerce.number().int().positive();

export const setRoutes = new Hono<AppEnv>()
  .post("/", async (c) => c.json(logSet(c.var.ctx, LogSetInput.parse(await c.req.json())), 201))
  .post("/:id/complete", async (c) => {
    const body = CompleteSetBody.parse(await c.req.json().catch(() => ({})));
    return c.json(completePlannedSet(c.var.ctx, CompletePlannedSetInput.parse({ ...body, set_id: Id.parse(c.req.param("id")) })));
  })
  .post("/:id/uncomplete", (c) => c.json(uncompleteSet(c.var.ctx, Id.parse(c.req.param("id")))))
  .patch("/:id", async (c) => c.json(updateSet(c.var.ctx, Id.parse(c.req.param("id")), SetPatch.parse(await c.req.json()))))
  .delete("/:id", (c) => c.json(deleteSet(c.var.ctx, Id.parse(c.req.param("id")))));
