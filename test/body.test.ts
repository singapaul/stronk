import { describe, expect, test } from "bun:test";
import { loadEnv } from "../src/env.ts";
import { bodyweightOn } from "../src/services/load.ts";
import { testApp, testEnv } from "./helpers.ts";

const INGEST = "i".repeat(40);

/** App with INGEST_TOKEN set, plus a helper that posts an import with the token. */
function setup() {
  const t = testApp({ env: { INGEST_TOKEN: INGEST } });
  const sync = async (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${INGEST}` }) => {
    const res = await t.app.request("/api/bodyweight/import", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const entry = async (date: string) => (await t.call("GET", "/api/bodyweight?limit=365")).body.entries.find((e: any) => e.date === date);
  return { ...t, sync, entry };
}

describe("bodyweight import auth", () => {
  test("accepts INGEST_TOKEN as Bearer or X-Api-Key, and basic auth", async () => {
    const { sync, auth } = setup();
    const body = { weight: [{ time: "2026-03-09T07:00:00Z", kilograms: 80 }] };
    expect((await sync(body)).status).toBe(200);
    expect((await sync(body, { "x-api-key": INGEST })).status).toBe(200);
    expect((await sync(body, auth)).status).toBe(200);
  });

  test("rejects a wrong or missing token", async () => {
    const { sync } = setup();
    const body = { weight: [] };
    expect((await sync(body, { authorization: `Bearer ${"x".repeat(40)}` })).status).toBe(401);
    expect((await sync(body, {})).status).toBe(401);
    // The MCP token isn't an ingest token.
    expect((await sync(body, { authorization: `Bearer ${testEnv.MCP_TOKEN}` })).status).toBe(401);
  });

  test("the ingest token works on the import route only", async () => {
    const { app } = setup();
    const headers = { authorization: `Bearer ${INGEST}` };
    expect((await app.request("/api/bodyweight", { headers })).status).toBe(401);
    expect((await app.request("/api/bodyweight/2026-03-09", { method: "PUT", headers, body: "{}" })).status).toBe(401);
    expect((await app.request("/mcp", { method: "POST", headers })).status).toBe(401);
  });

  test("without INGEST_TOKEN configured, only basic auth works", async () => {
    const { app, auth } = testApp();
    const req = (headers: Record<string, string>) =>
      app.request("/api/bodyweight/import", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    expect((await req({ authorization: "Bearer " })).status).toBe(401);
    expect((await req(auth)).status).toBe(200);
  });
});

describe("bodyweight import", () => {
  test("keeps the latest reading per training day and marks it synced", async () => {
    const { sync, entry } = setup();
    const res = await sync({
      timestamp: "2026-03-10T08:00:00Z",
      app_version: "1.0",
      weight: [
        { time: "2026-03-09T07:00:00Z", kilograms: 80.4 },
        { time: "2026-03-09T21:30:00Z", kilograms: 81.26 },
        // 02:00 London belongs to the previous training day (04:00 rollover).
        { time: "2026-03-10T02:00:00Z", kilograms: 81.5 },
        { time: "2026-03-10T07:15:00+01:00", kilograms: 80.123 },
      ],
      steps: [{ count: 1000 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual(["2026-03-09", "2026-03-10"]);
    expect(await entry("2026-03-09")).toMatchObject({ weight_kg: 81.5, source: "health_connect", measured_at: "2026-03-10T02:00:00.000Z" });
    expect(await entry("2026-03-10")).toMatchObject({ weight_kg: 80.12, source: "health_connect" });
  });

  test("resending the same batch changes nothing", async () => {
    const { sync } = setup();
    const body = { weight: [{ time: "2026-03-09T07:00:00Z", kilograms: 80 }], body_fat: [{ time: "2026-03-09T07:00:00Z", percentage: 18 }] };
    expect((await sync(body)).body.updated).toEqual(["2026-03-09"]);
    const again = await sync(body);
    expect(again.body.updated).toEqual([]);
    expect(again.body.unchanged).toBe(1);
  });

  test("an older reading never replaces a later one", async () => {
    const { sync, entry } = setup();
    await sync({ weight: [{ time: "2026-03-09T20:00:00Z", kilograms: 81 }] });
    const res = await sync({ weight: [{ time: "2026-03-09T07:00:00Z", kilograms: 79 }] });
    expect(res.body).toMatchObject({ updated: [], unchanged: 1 });
    expect((await entry("2026-03-09")).weight_kg).toBe(81);
  });

  test("manual entries win: sync never overwrites one, and a manual edit takes over a synced day", async () => {
    const { sync, call, entry } = setup();
    await call("PUT", "/api/bodyweight/2026-03-08", { weight_kg: 79.9, notes: "after breakfast" });
    const res = await sync({
      weight: [{ time: "2026-03-08T07:00:00Z", kilograms: 79 }],
      body_fat: [{ time: "2026-03-08T07:00:00Z", percentage: 18 }],
    });
    expect(res.body.skipped.manual_entry).toBe(1);
    expect(await entry("2026-03-08")).toMatchObject({ weight_kg: 79.9, fat_percent: null, source: "manual", notes: "after breakfast" });

    await sync({ weight: [{ time: "2026-03-09T07:00:00Z", kilograms: 80 }] });
    await call("PUT", "/api/bodyweight/2026-03-09", { weight_kg: 80.5 });
    expect(await entry("2026-03-09")).toMatchObject({ weight_kg: 80.5, source: "manual", measured_at: null });
    await sync({ weight: [{ time: "2026-03-09T09:00:00Z", kilograms: 82 }] });
    expect((await entry("2026-03-09")).weight_kg).toBe(80.5);
  });

  test("body fat attaches to the day's synced entry, or is skipped without one", async () => {
    const { sync, entry } = setup();
    const first = await sync({
      weight: [{ time: "2026-03-09T07:00:00Z", kilograms: 80 }],
      body_fat: [
        { time: "2026-03-09T07:00:00Z", percentage: 18.24 },
        { time: "2026-03-07T07:00:00Z", percentage: 19 },
      ],
    });
    expect(first.body.skipped.no_weight).toBe(1);
    expect(await entry("2026-03-09")).toMatchObject({ weight_kg: 80, fat_percent: 18.2 });
    expect(await entry("2026-03-07")).toBeUndefined();

    // Body fat arriving in a later batch on its own updates the entry.
    const later = await sync({ body_fat: [{ time: "2026-03-09T07:05:00Z", percentage: 17.9 }] });
    expect(later.body.updated).toEqual(["2026-03-09"]);
    expect((await entry("2026-03-09")).fat_percent).toBe(17.9);

    // A later weight without body fat keeps the day's body fat.
    await sync({ weight: [{ time: "2026-03-09T20:00:00Z", kilograms: 80.6 }] });
    expect(await entry("2026-03-09")).toMatchObject({ weight_kg: 80.6, fat_percent: 17.9 });
  });

  test("skips bad readings instead of rejecting the batch", async () => {
    const { sync } = setup();
    const res = await sync({
      weight: [
        { time: "2026-03-09T07:00:00Z", kilograms: 80 },
        { time: "2026-03-09T07:00:00Z", kilograms: 4 },
        { time: "yesterday", kilograms: 80 },
        { time: "2026-03-12T07:00:00Z", kilograms: 80 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toEqual(["2026-03-09"]);
    expect(res.body.skipped).toMatchObject({ out_of_range: 1, bad_time: 1, future: 1 });
  });

  test("rejects a malformed payload", async () => {
    const { sync } = setup();
    expect((await sync({ weight: [{ kilograms: 80 }] })).status).toBe(400);
    expect((await sync({ weight: "80" })).status).toBe(400);
  });

  test("synced weight loads bodyweight exercises", async () => {
    const { sync, db } = setup();
    await sync({ weight: [{ time: "2026-03-09T07:00:00Z", kilograms: 81 }] });
    expect(bodyweightOn(db, "2026-03-10")).toBe(81);
  });
});

describe("INGEST_TOKEN env", () => {
  const base = { ...testEnv, PORT: "3000", RATE_LIMIT_MAX: "1", RATE_LIMIT_WINDOW_S: "1" } as unknown as Record<string, string>;
  test("is optional, at least 32 characters, and distinct from the MCP tokens", () => {
    expect(loadEnv(base).INGEST_TOKEN).toBeUndefined();
    expect(loadEnv({ ...base, INGEST_TOKEN: "" }).INGEST_TOKEN).toBeUndefined();
    expect(loadEnv({ ...base, INGEST_TOKEN: INGEST }).INGEST_TOKEN).toBe(INGEST);
    expect(() => loadEnv({ ...base, INGEST_TOKEN: "short" })).toThrow(/INGEST_TOKEN must be at least 32/);
    expect(() => loadEnv({ ...base, INGEST_TOKEN: testEnv.MCP_TOKEN })).toThrow(/INGEST_TOKEN must differ/);
  });
});
