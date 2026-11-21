import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { BodyweightInput, BodyweightListInput, IsoDate } from "../schemas.ts";
import { deleteBodyweight, getBodyweight, logBodyweight } from "../services/body.ts";

export const bodyweightRoutes = new Hono<AppEnv>()
  .get("/", (c) => c.json(getBodyweight(c.var.ctx, BodyweightListInput.parse(c.req.query()))))
  .put("/:date", async (c) => {
    const date = IsoDate.parse(c.req.param("date"));
    return c.json(logBodyweight(c.var.ctx, { ...BodyweightInput.parse(await c.req.json()), date }));
  })
  .delete("/:date", (c) => c.json(deleteBodyweight(c.var.ctx, IsoDate.parse(c.req.param("date")))));
