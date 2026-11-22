import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "./app.ts";
import type { Env } from "./env.ts";
import type { Clock } from "./services/dates.ts";

/**
 * All auth lives here so it can be swapped (OAuth 2.1 for /mcp is the planned upgrade).
 *
 * REST  /api/*        Basic auth.
 * MCP   /mcp          Bearer MCP_TOKEN, or Basic auth.
 * MCP   /mcp/:token   Secret path (MCP_PATH_TOKEN) for clients that can't send headers (Claude app
 *                     custom connectors). Weaker: the token lives in the URL.
 */

/** Constant-time compare. Hashing first makes lengths equal so length doesn't leak either. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export type Credential = "basic" | "bearer" | "path" | "session";

/** Header the web app sends on every request. Cookie-authenticated writes require it (CSRF guard). */
export const WEB_CLIENT_HEADER = "x-stronk-client";

function parseBasic(header: string | undefined): { user: string; pass: string } | null {
  const m = header?.match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  let decoded: string;
  try {
    decoded = atob(m[1]!.trim());
  } catch {
    return null;
  }
  const i = decoded.indexOf(":");
  return i < 0 ? null : { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

function checkBasic(env: Env, header: string | undefined): boolean {
  const creds = parseBasic(header);
  if (!creds) return false;
  // Evaluate both so a wrong username takes as long as a wrong password.
  const u = safeEqual(creds.user, env.BASIC_AUTH_USER);
  const p = safeEqual(creds.pass, env.BASIC_AUTH_PASS);
  return u && p;
}

function checkBearer(env: Env, header: string | undefined): boolean {
  const m = header?.match(/^Bearer\s+(.+)$/i);
  return !!m && safeEqual(m[1]!.trim(), env.MCP_TOKEN);
}

export function checkPathToken(env: Env, token: string | undefined): boolean {
  return !!token && safeEqual(token, env.MCP_PATH_TOKEN);
}

/** Which credential (if any) authenticates this request for MCP. */
export function mcpCredential(env: Env, authHeader: string | undefined, pathToken?: string): Credential | null {
  if (pathToken !== undefined) return checkPathToken(env, pathToken) ? "path" : null;
  if (checkBearer(env, authHeader)) return "bearer";
  if (checkBasic(env, authHeader)) return "basic";
  return null;
}

const unauthorized = (realm: boolean) =>
  new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      ...(realm ? { "www-authenticate": 'Basic realm="stronk", charset="UTF-8"' } : {}),
    },
  });

/**
 * REST auth: basic auth, or the web app's session cookie. A cookie alone never authorises a write:
 * the request must also carry `X-Stronk-Client: web`, which another site can't add without a CORS
 * preflight this app never allows.
 */
export function restAuth(env: Env, session?: (c: Context) => string | null): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (checkBasic(env, c.req.header("authorization"))) {
      c.set("credential", "basic");
      return next();
    }
    const fromWeb = c.req.header(WEB_CLIENT_HEADER) === "web";
    if (session?.(c)) {
      const write = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
      if (write && !fromWeb) return c.json({ error: "Missing X-Stronk-Client header" }, 403);
      c.set("credential", "session");
      return next();
    }
    // No Basic challenge for the web app, so the browser doesn't pop up a login dialog.
    return unauthorized(!fromWeb);
  };
}

export function mcpAuth(env: Env): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cred = mcpCredential(env, c.req.header("authorization"), c.req.param("token"));
    if (!cred) return unauthorized(false);
    c.set("credential", cred);
    await next();
  };
}

// ---------------------------------------------------------------------------
// Rate limiting: fixed window per key, in memory (one machine, so that's enough).
// ---------------------------------------------------------------------------

export function createRateLimiter(opts: { max: number; windowMs: number; clock: Clock }) {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    /** Count a request. Returns seconds until reset when over the limit, else null. */
    hit(key: string): number | null {
      const now = opts.clock().getTime();
      let w = windows.get(key);
      if (!w || now - w.start >= opts.windowMs) {
        w = { start: now, count: 0 };
        windows.set(key, w);
      }
      w.count++;
      if (windows.size > 10_000) {
        for (const [k, v] of windows) if (now - v.start >= opts.windowMs) windows.delete(k);
      }
      return w.count > opts.max ? Math.ceil((w.start + opts.windowMs - now) / 1000) : null;
    },
  };
}

export const clientIp = (h: (name: string) => string | undefined) =>
  h("fly-client-ip") ?? h("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

/**
 * Runs before auth so failed logins are limited too: key by credential type when the request
 * presents one, else by client IP. A leaked secret URL is capped at max requests per window.
 */
export function rateLimit(limiter: ReturnType<typeof createRateLimiter>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.req.header("authorization");
    const pathToken = c.req.param("token");
    const kind = pathToken
      ? "path"
      : (auth?.match(/^(\w+)\s/)?.[1]?.toLowerCase() ?? (c.req.header("cookie")?.includes("stronk_session=") ? "session" : undefined));
    const key = kind ? `${kind}:${clientIp((n) => c.req.header(n))}` : `anon:${clientIp((n) => c.req.header(n))}`;
    const retry = limiter.hit(key);
    if (retry != null) {
      return c.json({ error: "Too many requests" }, 429, { "retry-after": String(retry) });
    }
    await next();
  };
}
