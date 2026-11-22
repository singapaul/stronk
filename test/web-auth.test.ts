import { describe, expect, test } from "bun:test";
import { loadEnv } from "../src/env.ts";
import { sign, verify } from "../src/web-auth.ts";
import { testApp } from "./helpers.ts";

const GOOGLE = {
  GOOGLE_CLIENT_ID: "client-123.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "shh",
  ALLOWED_EMAILS: "Lifter@Example.com, other@example.com",
  SESSION_SECRET: "s".repeat(40),
  PUBLIC_URL: "https://stronk.example.dev",
};

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const idToken = (claims: object) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;

/** A fake Google token endpoint returning an id_token with the given claims; records the request body. */
function fakeGoogle(claims: Record<string, unknown> | null, status = 200) {
  const calls: URLSearchParams[] = [];
  const fn = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify(claims ? { id_token: idToken(claims) } : {}), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const cookieHeader = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

/** Run /auth/google then the callback; returns the callback response and the cookies to keep. */
async function signIn(app: ReturnType<typeof testApp>["app"], opts: { stateOverride?: string } = {}) {
  const start = await app.request("/auth/google");
  expect(start.status).toBe(302);
  const loc = new URL(start.headers.get("location")!);
  const state = opts.stateOverride ?? loc.searchParams.get("state")!;
  const res = await app.request(`/auth/google/callback?code=abc&state=${state}`, { headers: { cookie: cookieHeader(start) } });
  return { start, loc, res, cookie: cookieHeader(res) };
}

const validClaims = (clock: { (): Date }) => ({
  iss: "https://accounts.google.com",
  aud: GOOGLE.GOOGLE_CLIENT_ID,
  exp: Math.floor(clock().getTime() / 1000) + 3600,
  email: "lifter@example.com",
  email_verified: true,
});

describe("signed values", () => {
  test("round-trip and reject tampering", () => {
    const v = sign("k".repeat(32), "a@b.c|123");
    expect(verify("k".repeat(32), v)).toBe("a@b.c|123");
    expect(verify("x".repeat(32), v)).toBeNull();
    expect(verify("k".repeat(32), v.replace(/^./, "Z"))).toBeNull();
    expect(verify("k".repeat(32), undefined)).toBeNull();
  });
});

describe("env", () => {
  const base = { BASIC_AUTH_USER: "u", BASIC_AUTH_PASS: "p", MCP_TOKEN: "a".repeat(32), MCP_PATH_TOKEN: "b".repeat(32) };
  test("Google settings are all-or-none", () => {
    expect(() => loadEnv(base)).not.toThrow();
    expect(() => loadEnv({ ...base, ...GOOGLE })).not.toThrow();
    expect(() => loadEnv({ ...base, GOOGLE_CLIENT_ID: "x" })).toThrow(/partly configured/);
  });
});

describe("Google sign-in", () => {
  test("redirects to Google with PKCE, then signs an allowed email in", async () => {
    const g = fakeGoogle(validClaims(testApp().clock));
    const t2 = testApp({ env: GOOGLE, fetch: g.fn });
    const { loc, res, cookie } = await signIn(t2.app);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://stronk.example.dev/auth/google/callback");
    expect(loc.searchParams.get("scope")).toBe("openid email");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/stronk_session=.*HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Secure/);
    // The code exchange sent the PKCE verifier and our redirect URI.
    expect(g.calls[0]!.get("code_verifier")).toBeTruthy();
    expect(g.calls[0]!.get("redirect_uri")).toBe("https://stronk.example.dev/auth/google/callback");
    const me = await t2.app.request("/auth/me", { headers: { cookie } });
    expect(await me.json()).toEqual({ email: "lifter@example.com" });
  });

  test("refuses emails not on the list, unverified emails, wrong audience and mismatched state", async () => {
    const cases: [Record<string, unknown>, number][] = [
      [{ email: "stranger@example.com" }, 403],
      [{ email_verified: false }, 400],
      [{ aud: "someone-else" }, 400],
      [{ iss: "https://evil.example" }, 400],
    ];
    for (const [override, status] of cases) {
      const clockT = testApp();
      const g = fakeGoogle({ ...validClaims(clockT.clock), ...override });
      const t = testApp({ env: GOOGLE, fetch: g.fn });
      const { res } = await signIn(t.app);
      expect(res.status, JSON.stringify(override)).toBe(status);
      expect(res.headers.getSetCookie().join()).not.toContain("stronk_session=");
    }
    const g = fakeGoogle(validClaims(testApp().clock));
    const t = testApp({ env: GOOGLE, fetch: g.fn });
    const { res } = await signIn(t.app, { stateOverride: "forged" });
    expect(res.status).toBe(400);
    expect(g.calls).toHaveLength(0);
  });

  test("without Google config, sign-in explains how to set it up", async () => {
    const { app } = testApp();
    expect((await app.request("/auth/google")).status).toBe(503);
    const me = await app.request("/auth/me");
    expect(me.status).toBe(401);
    expect(await me.json()).toMatchObject({ google: "disabled", dev_login: "disabled" });
  });
});

describe("session cookie on the API", () => {
  async function signedIn() {
    const g = fakeGoogle(validClaims(testApp().clock));
    const t = testApp({ env: GOOGLE, fetch: g.fn });
    const { cookie } = await signIn(t.app);
    return { ...t, cookie };
  }

  test("reads work with the cookie; writes also need X-Stronk-Client", async () => {
    const { app, cookie } = await signedIn();
    expect((await app.request("/api/workouts", { headers: { cookie } })).status).toBe(200);
    const body = JSON.stringify({ weight_kg: 80 });
    const noHeader = await app.request("/api/bodyweight/2026-03-10", { method: "PUT", body, headers: { cookie, "content-type": "application/json" } });
    expect(noHeader.status).toBe(403);
    const ok = await app.request("/api/bodyweight/2026-03-10", {
      method: "PUT",
      body,
      headers: { cookie, "content-type": "application/json", "x-stronk-client": "web" },
    });
    expect(ok.status).toBe(200);
  });

  test("the header alone isn't enough, and web 401s don't trigger a browser login popup", async () => {
    const { app } = await signedIn();
    const res = await app.request("/api/workouts", { headers: { "x-stronk-client": "web" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect((await app.request("/api/workouts")).headers.get("www-authenticate")).toContain("Basic");
  });

  test("basic auth and the MCP token still work alongside it", async () => {
    const { app, auth, env } = await signedIn();
    expect((await app.request("/api/workouts", { headers: auth })).status).toBe(200);
    const mcp = await app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${env.MCP_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    expect(mcp.status).toBe(200);
  });

  test("expires after 30 days, renews when under 15 days remain, and logout clears it", async () => {
    const { app, cookie, clock } = await signedIn();
    clock.set("2026-03-30T18:00:00Z"); // 20 days later: valid, renewed
    const renewed = await app.request("/auth/me", { headers: { cookie } });
    expect(renewed.status).toBe(200);
    expect(renewed.headers.getSetCookie().join()).toContain("stronk_session=");
    clock.set("2026-04-12T18:00:00Z"); // 33 days after the original: the old cookie is dead
    expect((await app.request("/auth/me", { headers: { cookie } })).status).toBe(401);
    const out = await app.request("/auth/logout", { method: "POST", headers: { cookie } });
    expect(out.headers.getSetCookie().join()).toMatch(/stronk_session=;/);
  });

  test("removing an email from ALLOWED_EMAILS signs it out", async () => {
    const { cookie } = await signedIn();
    const other = testApp({ env: { ...GOOGLE, ALLOWED_EMAILS: "other@example.com" } });
    expect((await other.app.request("/auth/me", { headers: { cookie } })).status).toBe(401);
  });
});

describe("dev sign-in", () => {
  test("works outside production only", async () => {
    const dev = testApp({ env: { DEV_LOGIN_EMAIL: "dev@example.com", NODE_ENV: "development" } });
    const res = await dev.app.request("/auth/dev");
    expect(res.status).toBe(302);
    const cookie = cookieHeader(res);
    expect(await (await dev.app.request("/auth/me", { headers: { cookie } })).json()).toEqual({ email: "dev@example.com" });
    const prod = testApp({ env: { DEV_LOGIN_EMAIL: "dev@example.com", NODE_ENV: "production" } });
    expect((await prod.app.request("/auth/dev")).status).toBe(404);
  });
});
