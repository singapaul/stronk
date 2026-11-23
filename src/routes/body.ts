import { Hono, type Context } from "hono";
import type { AppEnv } from "../app.ts";
import { BodyweightImportInput, BodyweightInput, BodyweightListInput, IsoDate } from "../schemas.ts";
import { deleteBodyweight, getBodyweight, importBodyweight, logBodyweight } from "../services/body.ts";

export const bodyweightRoutes = new Hono<AppEnv>()
  .get("/", (c) => c.json(getBodyweight(c.var.ctx, BodyweightListInput.parse(c.req.query()))))
  .put("/:date", async (c) => {
    const date = IsoDate.parse(c.req.param("date"));
    return c.json(logBodyweight(c.var.ctx, { ...BodyweightInput.parse(await c.req.json()), date }));
  })
  .delete("/:date", (c) => c.json(deleteBodyweight(c.var.ctx, IsoDate.parse(c.req.param("date")))));

/** POST /api/bodyweight/import. Mounted on its own in app.ts because it has its own auth (ingestAuth). */
export const importBodyweightHandler = async (c: Context<AppEnv>) =>
  c.json(importBodyweight(c.var.ctx, BodyweightImportInput.parse(await c.req.json())));
