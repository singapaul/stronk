import { existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./app.ts";

/**
 * Serves the built web app (web/dist) and falls back to index.html for client-side routes.
 * API, MCP, docs and auth paths never fall back, so their 404s stay JSON.
 */

export const DEFAULT_WEB_DIST = join(import.meta.dir, "..", "web", "dist");

const NOT_APP = ["/api", "/mcp", "/docs", "/openapi.json", "/auth", "/health"];

/** Exercise images come from free-exercise-db on GitHub; everything else is same-origin. */
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: https://raw.githubusercontent.com",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://accounts.google.com",
].join("; ");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function cacheControl(path: string) {
  // Hashed build assets never change; the shell and service worker must always be revalidated.
  if (path.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  return "no-cache";
}

export function webApp(dist = DEFAULT_WEB_DIST): MiddlewareHandler<AppEnv> {
  const root = normalize(dist);
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    const path = decodeURIComponent(new URL(c.req.url).pathname);
    if (NOT_APP.some((p) => path === p || path.startsWith(`${p}/`))) return next();

    const serve = async (file: string, urlPath: string) => {
      const ext = file.slice(file.lastIndexOf("."));
      return new Response(Bun.file(file), {
        headers: {
          "content-type": TYPES[ext] ?? "application/octet-stream",
          "cache-control": cacheControl(urlPath),
          "content-security-policy": CSP,
          "x-content-type-options": "nosniff",
          "referrer-policy": "same-origin",
        },
      });
    };

    const candidate = normalize(join(root, path));
    const inside = candidate === root || candidate.startsWith(root + sep);
    if (inside && path !== "/" && existsSync(candidate) && Bun.file(candidate).size > 0 && !path.endsWith("/")) {
      return serve(candidate, path);
    }
    // A missing asset is a real 404, not the app shell.
    if (/\.[a-z0-9]+$/i.test(path)) return next();
    const index = join(root, "index.html");
    if (!existsSync(index)) {
      return c.html("<!doctype html><title>stronk</title><p>The web app isn't built. Run <code>bun run web:build</code>.</p>", 503);
    }
    return serve(index, "/index.html");
  };
}
