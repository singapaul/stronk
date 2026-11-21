import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Handler } from "hono";
import type { AppEnv } from "../app.ts";
import { buildMcpServer } from "./server.ts";

/**
 * Stateless Streamable HTTP: a fresh server + transport per request, JSON responses, no sessions.
 * Nothing lives in memory between requests, so restarts and Fly auto-stop are harmless.
 */
export const mcpHandler: Handler<AppEnv> = async (c) => {
  const server = buildMcpServer(c.var.ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    await server.close();
  }
};
