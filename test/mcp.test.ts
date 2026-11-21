import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../src/mcp/server.ts";
import { seedMini, testApp, testEnv } from "./helpers.ts";

async function setup() {
  const t = testApp();
  seedMini(t.db);
  const server = buildMcpServer(t.ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      structuredContent?: any;
      content: { type: string; text: string }[];
    };
    const text = res.content[0]!.text;
    // SDK-level input validation errors are plain text; our tool errors are JSON.
    let data: any = res.structuredContent;
    if (data === undefined) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text };
      }
    }
    return { ...res, text, data };
  };
  return { ...t, client, call };
}

describe("MCP server", () => {
  test("lists the 20 tools with instructions", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "complete_planned_set", "create_custom_exercise", "create_routine", "delete_set", "get_bodyweight", "get_exercise",
        "get_history", "get_prs", "get_recent_workouts", "get_routine", "get_workout", "list_routines", "log_bodyweight",
        "log_set", "log_workout", "plan_session", "search_exercises", "start_routine", "update_routine", "update_set",
      ].sort(),
    );
    expect(tools.find((t) => t.name === "delete_set")!.annotations?.destructiveHint).toBe(true);
    expect(client.getInstructions()).toContain("kilograms");
  });
});

describe("tools: happy path + one error path each", () => {
  test("search_exercises", async () => {
    const { call } = await setup();
    const ok = await call("search_exercises", { query: "bench" });
    expect(ok.data.results[0].id).toBe("bench");
    expect(ok.text).toContain("bench (Barbell Bench Press)");
    const bad = await call("search_exercises", { limit: 0 });
    expect(bad.isError).toBe(true);
  });

  test("get_exercise", async () => {
    const { call } = await setup();
    expect((await call("get_exercise", { exercise_id: "squat" })).data.name).toBe("Barbell Squat");
    const bad = await call("get_exercise", { exercise_id: "squatt" });
    expect(bad.isError).toBe(true);
    expect(bad.data.details.suggestions[0].id).toBe("squat");
  });

  test("create_custom_exercise", async () => {
    const { call } = await setup();
    const ok = await call("create_custom_exercise", { name: "Belt Squat", primary_muscles: ["quadriceps"], type: "weight_reps" });
    expect(ok.data.id).toBe("custom_belt_squat");
    expect((await call("create_custom_exercise", { name: "Belt Squat", primary_muscles: ["quadriceps"] })).isError).toBe(true);
  });

  test("log_set", async () => {
    const { call } = await setup();
    const ok = await call("log_set", { exercise_id: "bench", reps: 5, weight_kg: 80, rpe: 8 });
    expect(ok.isError).toBeFalsy();
    expect(ok.data.date).toBe("2026-03-10");
    expect(ok.text).toContain("Logged Barbell Bench Press set 1: 80×5 @8");
    const bad = await call("log_set", { exercise_id: "bench_press", reps: 5, weight_kg: 80 });
    expect(bad.isError).toBe(true);
    expect(bad.data.details.suggestions.map((s: any) => s.id)).toContain("bench");
  });

  test("log_workout", async () => {
    const { call } = await setup();
    const ok = await call("log_workout", {
      date: "2026-03-08",
      name: "Upper",
      exercises: [{ exercise_id: "bench", sets: [{ reps: 5, weight_kg: 80 }] }, { exercise_id: "pullup", sets: [{ reps: 8 }] }],
    });
    expect(ok.data.workout.totals.performed_sets).toBe(2);
    expect(ok.text).toContain("Upper on 2026-03-08");
    expect((await call("log_workout", { exercises: [] })).isError).toBe(true);
  });

  test("plan_session + get_workout + complete_planned_set", async () => {
    const { call } = await setup();
    const plan = await call("plan_session", { name: "Push", exercises: [{ exercise_id: "bench", sets: [{ reps_min: 5, reps_max: 8, weight_kg: 80 }, { reps: 5, weight_kg: 80 }] }] });
    expect(plan.data.status).toBe("planned");
    const w = await call("get_workout", {});
    const planned = w.data.exercises[0].sets[1];
    expect(w.text).toContain(`plan #${planned.id}`);
    const done = await call("complete_planned_set", { set_id: planned.id, reps: 6, weight_kg: 80 });
    expect(done.data.set.is_planned).toBe(false);
    expect((await call("complete_planned_set", { set_id: planned.id, reps: 6 })).isError).toBe(true);
    expect((await call("plan_session", { name: "X", exercises: [{ exercise_id: "nope", sets: [{ reps: 5 }] }] })).isError).toBe(true);
  });

  test("get_workout for an empty day isn't an error", async () => {
    const { call } = await setup();
    const res = await call("get_workout", { date: "2026-01-01" });
    expect(res.isError).toBeFalsy();
    expect(res.data.workout).toBeNull();
    expect((await call("get_workout", { workout_id: 999 })).isError).toBe(true);
  });

  test("update_set and delete_set", async () => {
    const { call } = await setup();
    const s = await call("log_set", { exercise_id: "bench", reps: 5, weight_kg: 800 });
    const fixed = await call("update_set", { set_id: s.data.set.id, weight_kg: 80 });
    expect(fixed.data.set.weight_kg).toBe(80);
    expect((await call("update_set", { set_id: 999, reps: 1 })).isError).toBe(true);
    expect((await call("delete_set", { set_id: s.data.set.id })).data.deleted).toBe(true);
    expect((await call("delete_set", { set_id: s.data.set.id })).isError).toBe(true);
  });

  test("get_history, get_recent_workouts and get_prs", async () => {
    const { call } = await setup();
    await call("log_set", { exercise_id: "bench", reps: 5, weight_kg: 80, date: "2026-03-01" });
    const pr = await call("log_set", { exercise_id: "bench", reps: 5, weight_kg: 85 });
    expect(pr.text).toContain("New PR: heaviest, e1rm");
    const h = await call("get_history", { exercise_id: "bench" });
    expect(h.data.sessions).toHaveLength(2);
    expect(h.text).toContain("2026-03-10: 85×5");
    expect((await call("get_history", { exercise_id: "zzz" })).isError).toBe(true);
    const recent = await call("get_recent_workouts", { days: 14 });
    expect(recent.data.workouts).toHaveLength(2);
    expect((await call("get_recent_workouts", { days: 0 })).isError).toBe(true);
    const prs = await call("get_prs", {});
    expect(prs.data.records[0].heaviest.load_kg).toBe(85);
    expect((await call("get_prs", { exercise_id: "zzz" })).isError).toBe(true);
  });

  test("routines: create, list, get, update, start", async () => {
    const { call } = await setup();
    const r = await call("create_routine", { name: "Push A", exercises: [{ exercise_id: "bench", sets: [{ reps_min: 5, reps_max: 8, weight_kg: 80 }] }] });
    expect(r.data.id).toBeGreaterThan(0);
    expect((await call("create_routine", { name: "Push A", exercises: [{ exercise_id: "bench", sets: [{ reps: 5 }] }] })).isError).toBe(true);
    expect((await call("list_routines")).text).toContain("Push A");
    expect((await call("get_routine", { routine_id: r.data.id })).data.name).toBe("Push A");
    expect((await call("get_routine", { routine_id: 999 })).isError).toBe(true);
    const upd = await call("update_routine", { routine_id: r.data.id, name: "Push 1" });
    expect(upd.data.name).toBe("Push 1");
    expect((await call("update_routine", { routine_id: r.data.id })).isError).toBe(true);
    const started = await call("start_routine", { routine_id: r.data.id });
    expect(started.data).toMatchObject({ status: "planned", routine_id: r.data.id });
    expect((await call("start_routine", { routine_id: 999 })).isError).toBe(true);
  });

  test("bodyweight", async () => {
    const { call } = await setup();
    expect((await call("log_bodyweight", { weight_kg: 81.5 })).data.date).toBe("2026-03-10");
    expect((await call("get_bodyweight", {})).text).toContain("81.5kg");
    expect((await call("log_bodyweight", { weight_kg: 1 })).isError).toBe(true);
  });
});

describe("HTTP /mcp", () => {
  const init = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  };
  const post = (app: any, path: string, headers: Record<string, string> = {}, body: unknown = init) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    });

  test("rejects requests with no or wrong credentials", async () => {
    const { app } = testApp();
    expect((await post(app, "/mcp")).status).toBe(401);
    expect((await post(app, "/mcp", { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post(app, "/mcp/wrong-token")).status).toBe(401);
    expect((await post(app, `/mcp/${testEnv.MCP_TOKEN}`)).status).toBe(401);
  });

  test("accepts bearer, basic and secret path", async () => {
    const { app, auth } = testApp();
    for (const [path, headers] of [
      ["/mcp", { authorization: `Bearer ${testEnv.MCP_TOKEN}` }],
      ["/mcp", auth],
      [`/mcp/${testEnv.MCP_PATH_TOKEN}`, {}],
    ] as const) {
      const res = await post(app, path, headers);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.result.serverInfo.name).toBe("stronk-gym");
      expect(body.result.instructions).toContain("kilograms");
    }
  });

  test("stateless tool call over HTTP", async () => {
    const { app, db } = testApp();
    seedMini(db);
    const res = await post(
      app,
      "/mcp",
      { authorization: `Bearer ${testEnv.MCP_TOKEN}`, "mcp-protocol-version": "2025-06-18" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "log_set", arguments: { exercise_id: "bench", reps: 5, weight_kg: 100 } } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.structuredContent.set.weight_kg).toBe(100);
  });
});
