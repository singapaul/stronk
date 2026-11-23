import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import type { Ctx } from "../app.ts";
import { buildMcpServer, SERVER_INSTRUCTIONS } from "../mcp/server.ts";
import examples from "./examples.json" with { type: "json" };
import { DOC_ROUTES, TAGS, type DocRoute } from "./routes.ts";

type Json = Record<string, unknown>;

/** Hono `:param` → OpenAPI `{param}`. */
export const toOpenApiPath = (path: string) => path.replace(/:(\w+)/g, "{$1}");

/** JSON Schema from Zod, minus noise: no `$schema`, and no regex `pattern` where a `format` already says it. */
function jsonSchema(schema: z.ZodType, io: "input" | "output"): Json {
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== "object") return node;
    const out: Json = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$schema") continue;
      if (k === "pattern" && "format" in node) continue;
      out[k] = clean(v);
    }
    return out;
  };
  return clean(z.toJSONSchema(schema, { io, unrepresentable: "any" })) as Json;
}

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: "Validation failed or the request is inconsistent",
  401: "Missing or wrong credentials",
  404: "Not found. Unknown exercise ids include the 5 closest matches in `details.suggestions`",
  409: "Conflicts with existing data (duplicate name, date already taken, set already performed)",
  429: "Rate limited. Retry after the `Retry-After` seconds",
};

const errorResponse = (status: number) => ({
  description: ERROR_DESCRIPTIONS[status] ?? "Error",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const EXAMPLES = examples as Record<string, unknown>;

function operation(r: DocRoute): Json {
  const params: Json[] = [];
  for (const [name, description] of Object.entries(r.params ?? {})) {
    params.push({ name, in: "path", required: true, description, schema: { type: "string" } });
  }
  for (const [name, field] of Object.entries(r.query?.shape ?? {})) {
    const f = field as z.ZodType;
    const schema = jsonSchema(f, "output");
    const description = schema.description;
    delete schema.description;
    params.push({
      name,
      in: "query",
      required: !f.safeParse(undefined).success,
      ...(description ? { description } : {}),
      schema,
    });
  }
  const example = EXAMPLES[`${r.method.toUpperCase()} ${r.path}`];
  const responses: Json = {
    [r.ok.status]: {
      description: r.ok.description,
      content: { "application/json": { schema: { type: "object" }, ...(example !== undefined ? { example } : {}) } },
    },
  };
  for (const status of [...(r.errors ?? []), 401, 429]) responses[status] = errorResponse(status);
  return {
    tags: [r.tag],
    summary: r.summary,
    ...(r.description ? { description: r.description } : {}),
    operationId: `${r.method}${toOpenApiPath(r.path).replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""))}`,
    ...(params.length ? { parameters: params } : {}),
    ...(r.ingest ? { security: [{ ingestToken: [] }, { basicAuth: [] }] } : {}),
    ...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(r.body, "input") } } } } : {}),
    responses,
  };
}

// ---------------------------------------------------------------------------
// MCP: described from the live server so it can't drift.
// ---------------------------------------------------------------------------

type ToolInfo = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

export async function listMcpTools(ctx: Ctx): Promise<ToolInfo[]> {
  const server = buildMcpServer(ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "openapi-docs", version: "0" });
  await client.connect(clientT);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

/** Markdown table cell: escape pipes, and angle brackets so `<slug>` isn't swallowed as HTML. */
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, " ");

function mcpDescription(tools: ToolInfo[]): string {
  const rows = tools.map((t) => {
    const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
    const required = new Set(t.inputSchema.required ?? []);
    const fields = Object.keys(props).map((k) => (required.has(k) ? `**${k}**` : k)).join(", ") || "-";
    const hints = [t.annotations?.readOnlyHint ? "read-only" : null, t.annotations?.destructiveHint ? "destructive" : null]
      .filter(Boolean)
      .join(", ");
    return `| \`${t.name}\` | ${cell(t.description ?? "")} | ${fields} | ${hints || "-"} |`;
  });
  return `## MCP for Claude

An [MCP](https://modelcontextprotocol.io) server in the same process, so Claude can search exercises, log sets, read history and plan sessions. It calls the same services as the REST API.

**Transport:** Streamable HTTP, stateless (JSON responses, no sessions): POST JSON-RPC messages to the endpoint.

**Auth (any one):**
1. \`Authorization: Bearer <MCP_TOKEN>\`, for clients that can send headers
2. Basic auth with the REST credentials
3. Secret path \`/mcp/<MCP_PATH_TOKEN>\`, for clients that can't send headers. Weaker: the token lives in the URL. OAuth 2.1 is the planned upgrade.

**Connect Claude Code:**
\`\`\`
claude mcp add --transport http gym https://<host>/mcp --header "Authorization: Bearer <MCP_TOKEN>"
\`\`\`
**Connect the Claude app:** Settings → Connectors → Add custom connector → \`https://<host>/mcp/<MCP_PATH_TOKEN>\`

**Instructions sent to Claude:**

${SERVER_INSTRUCTIONS.split("\n").map((l) => `> ${l}`).join("\n")}

**Tools (${tools.length})**. Bold fields are required:

| Tool | What it does | Input | Hints |
|---|---|---|---|
${rows.join("\n")}`;
}

const JSONRPC_BODY = {
  type: "object",
  required: ["jsonrpc", "method"],
  properties: {
    jsonrpc: { const: "2.0" },
    id: { oneOf: [{ type: "integer" }, { type: "string" }] },
    method: { type: "string", examples: ["initialize", "tools/list", "tools/call"] },
    params: { type: "object" },
  },
};

const MCP_EXAMPLES = {
  initialize: {
    summary: "initialize",
    value: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "swagger", version: "0" } } },
  },
  toolsList: { summary: "tools/list", value: { jsonrpc: "2.0", id: 2, method: "tools/list" } },
  logSet: {
    summary: "tools/call log_set",
    value: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "log_set", arguments: { exercise_id: "Barbell_Bench_Press_-_Medium_Grip", reps: 5, weight_kg: 80, rpe: 8 } },
    },
  },
};

function mcpOperation(withToken: boolean): Json {
  return {
    tags: ["MCP"],
    summary: withToken ? "MCP endpoint (secret path)" : "MCP endpoint",
    description: withToken
      ? "Same as `/mcp`, authenticated by the secret path segment instead of a header. For the Claude app's custom connectors."
      : "Authenticate with `Authorization: Bearer <MCP_TOKEN>` or basic auth. Send `Accept: application/json, text/event-stream`.",
    operationId: withToken ? "mcpSecretPath" : "mcp",
    ...(withToken
      ? { parameters: [{ name: "token", in: "path", required: true, description: "MCP_PATH_TOKEN", schema: { type: "string", minLength: 32 } }], security: [] }
      : { security: [{ bearerAuth: [] }, { basicAuth: [] }] }),
    requestBody: { required: true, content: { "application/json": { schema: JSONRPC_BODY, examples: MCP_EXAMPLES } } },
    responses: {
      200: { description: "JSON-RPC response", content: { "application/json": { schema: { type: "object" } } } },
      202: { description: "Notification accepted (no body)" },
      401: errorResponse(401),
      429: errorResponse(429),
    },
  };
}

// ---------------------------------------------------------------------------

async function build(ctx: Ctx): Promise<Json> {
  const paths: Record<string, Json> = {};
  for (const r of DOC_ROUTES) {
    const p = toOpenApiPath(r.path);
    paths[p] = { ...(paths[p] ?? {}), [r.method]: operation(r) };
  }
  paths["/mcp"] = { post: mcpOperation(false) };
  paths["/mcp/{token}"] = { post: mcpOperation(true) };

  const tools = await listMcpTools(ctx);
  return {
    openapi: "3.1.0",
    info: {
      title: "stronk gym API",
      version: pkg.version,
      description:
        "Personal gym log: exercises, workouts, sets, routines, bodyweight and stats, plus an MCP endpoint for Claude.\n\n" +
        "- All weights are **kilograms**.\n- Every `/api` route uses **basic auth** (use Authorize, or your browser login for this page carries over).\n" +
        "- Errors look like `{ \"error\": string, \"details\"?: any }`.\n- Rate limited per credential and IP (429 with `Retry-After`).\n\n" +
        mcpDescription(tools),
    },
    servers: [{ url: "/" }],
    security: [{ basicAuth: [] }],
    tags: Object.entries(TAGS).map(([name, description]) => ({ name, description })),
    paths,
    components: {
      securitySchemes: {
        basicAuth: { type: "http", scheme: "basic" },
        bearerAuth: { type: "http", scheme: "bearer", description: "MCP_TOKEN (MCP endpoint only)" },
        ingestToken: { type: "http", scheme: "bearer", description: "INGEST_TOKEN (bodyweight import only)" },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "string" }, details: { description: "Validation issues, suggestions or conflicting ids" } },
        },
      },
    },
  };
}

const cache = new WeakMap<Ctx, Promise<Json>>();

/** The OpenAPI document, built once per app instance. */
export function buildOpenApi(ctx: Ctx): Promise<Json> {
  let doc = cache.get(ctx);
  if (!doc) {
    doc = build(ctx);
    cache.set(ctx, doc);
  }
  return doc;
}
