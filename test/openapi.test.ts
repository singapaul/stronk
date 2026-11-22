import { beforeAll, describe, expect, test } from "bun:test";
import { buildOpenApi, listMcpTools, toOpenApiPath } from "../src/openapi/build.ts";
import committed from "../src/openapi/examples.json";
import { runExampleScenario } from "../src/openapi/example-scenario.ts";
import { testApp, testEnv } from "./helpers.ts";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

let spec: any;
let app: ReturnType<typeof testApp>["app"];
let ctx: ReturnType<typeof testApp>["ctx"];
beforeAll(async () => {
  ({ app, ctx } = testApp());
  spec = await buildOpenApi(ctx);
});

const specOps = () => {
  const ops = new Set<string>();
  for (const [path, item] of Object.entries<any>(spec.paths)) {
    for (const m of METHODS) if (item[m]) ops.add(`${m.toUpperCase()} ${path}`);
  }
  return ops;
};

describe("OpenAPI spec", () => {
  test("documents exactly the REST routes the app serves", () => {
    const served = new Set(
      app.routes.filter((r) => r.path.startsWith("/api/") && r.method !== "ALL").map((r) => `${r.method} ${toOpenApiPath(r.path)}`),
    );
    const documented = new Set([...specOps()].filter((o) => o.includes(" /api/")));
    expect([...served].filter((o) => !documented.has(o)), "Undocumented routes: add an entry to DOC_ROUTES in src/openapi/routes.ts").toEqual([]);
    expect([...documented].filter((o) => !served.has(o)), "Documented in src/openapi/routes.ts but not served by the app").toEqual([]);
  });

  test("is OpenAPI 3.1 with summaries, auth errors and resolvable refs", () => {
    expect(spec.openapi).toBe("3.1.0");
    for (const [path, item] of Object.entries<any>(spec.paths)) {
      for (const m of METHODS) {
        const op = item[m];
        if (!op) continue;
        expect(op.summary, `${m} ${path}`).toBeTruthy();
        expect(op.responses["401"], `${m} ${path}`).toBeDefined();
        for (const p of path.match(/\{(\w+)\}/g) ?? []) {
          expect(op.parameters?.some((x: any) => x.in === "path" && `{${x.name}}` === p), `${m} ${path} ${p}`).toBe(true);
        }
      }
    }
    const refs = JSON.stringify(spec).match(/"#\/components\/[^"]+"/g) ?? [];
    for (const ref of refs) {
      const parts = ref.slice(3, -1).split("/");
      let node: any = spec;
      for (const part of parts) node = node?.[part];
      expect(node, ref).toBeDefined();
    }
    const ids = [...JSON.stringify(spec).matchAll(/"operationId":"([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("query params use parsed types and know what's required", () => {
    const search = spec.paths["/api/exercises"].get.parameters;
    const limit = search.find((p: any) => p.name === "limit");
    expect(limit).toMatchObject({ in: "query", required: false, schema: { type: "integer", default: 10 } });
    expect(search.some((p: any) => p.name === "q")).toBe(true);
    const body = spec.paths["/api/sets"].post.requestBody.content["application/json"].schema;
    expect(body.required).toEqual(["exercise_id"]);
    expect(body.properties.weight_kg.description).toContain("kg");
  });

  test("every documented REST operation has an example response", () => {
    for (const op of specOps()) {
      if (!op.includes(" /api/")) continue;
      const [m, p] = op.split(" ");
      const item = spec.paths[p!][m!.toLowerCase()];
      const ok = Object.entries<any>(item.responses).find(([s]) => s.startsWith("2"))![1];
      expect(ok.content["application/json"].example, `${op}: add a call for it in src/openapi/example-scenario.ts, then run \`bun run docs:examples\``).toBeDefined();
    }
  });

  test("committed examples still match what the API returns", async () => {
    const live = await runExampleScenario();
    expect(Object.keys(live).sort(), "Run `bun run docs:examples` to refresh src/openapi/examples.json").toEqual(Object.keys(committed).sort());
    for (const [key, body] of Object.entries(live)) {
      const was = (committed as Record<string, unknown>)[key] as object;
      expect(Object.keys(body as object).sort(), `${key}: run \`bun run docs:examples\``).toEqual(Object.keys(was).sort());
    }
  });
});

describe("MCP docs", () => {
  test("lists every tool from the live server and explains how to connect", async () => {
    // The tool list itself is pinned in test/mcp.test.ts; here the docs just have to cover every live tool.
    const tools = await listMcpTools(ctx);
    expect(tools.length).toBeGreaterThan(0);
    const mcpTag = spec.info.description as string;
    for (const t of tools) expect(mcpTag).toContain(`\`${t.name}\``);
    expect(mcpTag).toContain("claude mcp add --transport http");
    expect(mcpTag).toContain("kilograms");
    expect(spec.paths["/mcp"].post.requestBody.content["application/json"].examples.toolsList).toBeDefined();
    expect(spec.paths["/mcp/{token}"].post.security).toEqual([]);
  });

  test("never contains the real tokens", () => {
    const text = JSON.stringify(spec);
    expect(text).not.toContain(testEnv.MCP_TOKEN);
    expect(text).not.toContain(testEnv.MCP_PATH_TOKEN);
    expect(text).not.toContain(testEnv.BASIC_AUTH_PASS);
  });
});

describe("/docs and /openapi.json", () => {
  test("need basic auth", async () => {
    expect((await app.request("/docs")).status).toBe(401);
    expect((await app.request("/openapi.json")).status).toBe(401);
    expect((await app.request("/health")).status).toBe(200);
  });

  test("serve Swagger UI and the spec when logged in", async () => {
    const { app, auth } = testApp();
    const docs = await app.request("/docs", { headers: auth });
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/html");
    const html = await docs.text();
    expect(html).toContain("/openapi.json");
    expect(html).toContain("swagger-ui");
    const json = await app.request("/openapi.json", { headers: auth });
    expect(json.status).toBe(200);
    expect(((await json.json()) as any).info.title).toBe("stronk gym API");
  });
});

describe("/docs spec URL", () => {
  test("is scheme-relative for a normal host and ignores a malicious Host header", async () => {
    const { app, auth } = testApp();
    const ok = await (await app.request("http://stronk.fly.dev/docs", { headers: { ...auth, host: "stronk.fly.dev" } })).text();
    expect(ok).toContain("//stronk.fly.dev/openapi.json");
    const evil = await (await app.request("/docs", { headers: { ...auth, host: 'x"></script><script>alert(1)</script>' } })).text();
    expect(evil).not.toContain("alert(1)");
  });
});
