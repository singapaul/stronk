import { describe, expect, test } from "bun:test";
import { mcpCredential, safeEqual } from "../src/auth.ts";
import { testApp, testEnv } from "./helpers.ts";

const basic = (u: string, p: string) => `Basic ${btoa(`${u}:${p}`)}`;

describe("REST basic auth", () => {
  test("rejects missing and wrong credentials with a Basic challenge", async () => {
    const { app } = testApp();
    const none = await app.request("/api/workouts");
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Basic");
    expect((await app.request("/api/workouts", { headers: { authorization: basic("lifter", "nope") } })).status).toBe(401);
    expect((await app.request("/api/workouts", { headers: { authorization: basic("nope", "hunter2") } })).status).toBe(401);
    expect((await app.request("/api/workouts", { headers: { authorization: "Basic !!!" } })).status).toBe(401);
  });

  test("accepts correct credentials", async () => {
    const { app } = testApp();
    const res = await app.request("/api/workouts", { headers: { authorization: basic("lifter", "hunter2") } });
    expect(res.status).toBe(200);
  });

  test("the MCP bearer token does not open REST", async () => {
    const { app } = testApp();
    const res = await app.request("/api/workouts", { headers: { authorization: `Bearer ${testEnv.MCP_TOKEN}` } });
    expect(res.status).toBe(401);
  });
});

describe("MCP credential check", () => {
  test("bearer, basic and path each work; wrong values don't", () => {
    expect(mcpCredential(testEnv, `Bearer ${testEnv.MCP_TOKEN}`)).toBe("bearer");
    expect(mcpCredential(testEnv, basic("lifter", "hunter2"))).toBe("basic");
    expect(mcpCredential(testEnv, undefined, testEnv.MCP_PATH_TOKEN)).toBe("path");
    expect(mcpCredential(testEnv, "Bearer wrong")).toBeNull();
    expect(mcpCredential(testEnv, undefined)).toBeNull();
    expect(mcpCredential(testEnv, undefined, "wrong")).toBeNull();
    // The bearer token is not a valid path token, and vice versa.
    expect(mcpCredential(testEnv, undefined, testEnv.MCP_TOKEN)).toBeNull();
    expect(mcpCredential(testEnv, `Bearer ${testEnv.MCP_PATH_TOKEN}`)).toBeNull();
  });

  test("safeEqual handles different lengths", () => {
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "ab")).toBe(false);
  });
});

describe("rate limit", () => {
  test("429s past the limit, resets after the window", async () => {
    const { app, clock, auth } = testApp({ env: { RATE_LIMIT_MAX: 3, RATE_LIMIT_WINDOW_S: 60 } });
    const hit = () => app.request("/api/workouts", { headers: auth });
    for (let i = 0; i < 3; i++) expect((await hit()).status).toBe(200);
    const limited = await hit();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    clock.set("2026-03-10T18:01:01Z");
    expect((await hit()).status).toBe(200);
  });

  test("failed logins are limited too", async () => {
    const { app } = testApp({ env: { RATE_LIMIT_MAX: 2 } });
    const bad = () => app.request("/api/workouts", { headers: { authorization: basic("x", "y") } });
    expect((await bad()).status).toBe(401);
    expect((await bad()).status).toBe(401);
    expect((await bad()).status).toBe(429);
  });

  test("/health is never limited", async () => {
    const { app } = testApp({ env: { RATE_LIMIT_MAX: 1 } });
    for (let i = 0; i < 3; i++) expect((await app.request("/health")).status).toBe(200);
  });
});
