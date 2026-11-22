import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { testApp } from "./helpers.ts";

const dist = join(import.meta.dir, "fixtures", "web-dist");

describe("web app serving", () => {
  test("serves the shell at / and for client routes, with a CSP", async () => {
    const { app } = testApp({ webDist: dist });
    for (const path of ["/", "/history", "/workout/12"]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toContain("stronk app");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  test("hashed assets are immutable; the service worker is always revalidated", async () => {
    const { app } = testApp({ webDist: dist });
    const asset = await app.request("/assets/app-abc123.js");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect((await app.request("/sw.js")).headers.get("cache-control")).toBe("no-cache");
  });

  test("API, MCP, docs and auth paths never fall back to the shell", async () => {
    const { app, auth } = testApp({ webDist: dist });
    const api = await app.request("/api/nope", { headers: auth });
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "Not found" });
    expect((await app.request("/auth/nope")).status).toBe(404);
    expect((await app.request("/health")).headers.get("content-type")).toContain("application/json");
  });

  test("missing files 404 and paths can't escape the build folder", async () => {
    const { app } = testApp({ webDist: dist });
    expect((await app.request("/assets/missing.js")).status).toBe(404);
    const escape = await app.request("/..%2f..%2fpackage.json");
    expect(escape.status).toBe(404);
  });

  test("explains when the app hasn't been built", async () => {
    const { app } = testApp();
    const res = await app.request("/");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("web:build");
  });
});
