import { createHash, createHmac, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "./app.ts";
import { safeEqual } from "./auth.ts";
import type { WebAuthConfig } from "./env.ts";
import type { Clock } from "./services/dates.ts";

/**
 * Google sign-in for the web app only. Claude (MCP token / secret path) and scripts (basic auth)
 * are unaffected.
 *
 * - Login: OAuth authorization-code flow with PKCE against Google; the id_token comes straight back
 *   from Google's token endpoint over TLS, so its claims are trusted without a JWKS check
 *   (OpenID Connect Core 3.1.3.7) and validated for issuer, audience, expiry and verified email.
 * - Session: a stateless signed cookie `email|expiry`, 30 days, renewed when under 15 days remain.
 *   Rotating SESSION_SECRET signs everyone out.
 */

export const SESSION_COOKIE = "stronk_session";
const OAUTH_COOKIE = "stronk_oauth";
const SESSION_DAYS = 30;
const RENEW_BELOW_DAYS = 15;
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url").toString("utf8");

/** `payload.signature`, HMAC-SHA256 over the payload. */
export function sign(secret: string, payload: string): string {
  const body = b64url(payload);
  return `${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;
}

export function verify(secret: string, value: string | undefined): string | null {
  if (!value) return null;
  const [body, sig] = value.split(".");
  if (!body || !sig) return null;
  const expected = b64url(createHmac("sha256", secret).update(body).digest());
  return safeEqual(sig, expected) ? fromB64url(body) : null;
}

export type WebAuthDeps = {
  config: WebAuthConfig | null;
  /** Signing secret: the configured one, or an ephemeral one when only dev sign-in is enabled. */
  sessionSecret: string | null;
  devEmail: string | null;
  clock: Clock;
  fetch: typeof fetch;
};

const nowS = (clock: Clock) => Math.floor(clock().getTime() / 1000);

function isSecure(deps: WebAuthDeps) {
  return !(deps.config?.publicUrl ?? "http://localhost").startsWith("http://");
}

function setSession(c: Context, deps: WebAuthDeps, email: string) {
  const exp = nowS(deps.clock) + SESSION_DAYS * 86400;
  setCookie(c, SESSION_COOKIE, sign(deps.sessionSecret!, `${email}|${exp}`), {
    httpOnly: true,
    secure: isSecure(deps),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

/** The signed-in email from the session cookie (renewing it when it's getting old), or null. */
export function readSession(c: Context, deps: WebAuthDeps): string | null {
  if (!deps.sessionSecret) return null;
  const payload = verify(deps.sessionSecret, getCookie(c, SESSION_COOKIE));
  if (!payload) return null;
  const [email, expRaw] = payload.split("|");
  const exp = Number(expRaw);
  const now = nowS(deps.clock);
  if (!email || !Number.isFinite(exp) || exp <= now) return null;
  // Still allowed? (Removing an email from ALLOWED_EMAILS signs that person out.)
  const allowed = deps.config?.allowedEmails.includes(email) || email === deps.devEmail;
  if (!allowed) return null;
  if (exp - now < RENEW_BELOW_DAYS * 86400) setSession(c, deps, email);
  return email;
}

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;background:#111;color:#eee}a{color:#7cc4ff}</style></head>
<body><h1>${title}</h1>${body}</body></html>`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export function webAuthRoutes(deps: WebAuthDeps) {
  const app = new Hono<AppEnv>();

  app.get("/google", (c) => {
    const cfg = deps.config;
    if (!cfg) {
      return c.html(page("Sign-in isn't set up", "<p>Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAILS, SESSION_SECRET and PUBLIC_URL (see the README).</p>"), 503);
    }
    const state = b64url(randomBytes(16));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    setCookie(c, OAUTH_COOKIE, sign(cfg.sessionSecret, `${state}|${verifier}|${nowS(deps.clock) + 600}`), {
      httpOnly: true,
      secure: isSecure(deps),
      sameSite: "Lax",
      path: "/auth",
      maxAge: 600,
    });
    const url = new URL(GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: `${cfg.publicUrl}/auth/google/callback`,
      response_type: "code",
      scope: "openid email",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    }).toString();
    return c.redirect(url.toString());
  });

  app.get("/google/callback", async (c) => {
    const cfg = deps.config;
    if (!cfg) return c.html(page("Sign-in isn't set up", ""), 503);
    const fail = (msg: string, status: 400 | 403 = 400) =>
      c.html(page("Couldn't sign you in", `<p>${escapeHtml(msg)}</p><p><a href="/">Back to the app</a></p>`), status);

    const stored = verify(cfg.sessionSecret, getCookie(c, OAUTH_COOKIE));
    deleteCookie(c, OAUTH_COOKIE, { path: "/auth" });
    if (c.req.query("error")) return fail(`Google said: ${c.req.query("error")}`);
    const [state, verifier, expRaw] = stored?.split("|") ?? [];
    if (!state || !verifier || Number(expRaw) <= nowS(deps.clock) || !safeEqual(state, c.req.query("state") ?? "")) {
      return fail("The sign-in attempt expired or didn't match. Try again.");
    }
    const code = c.req.query("code");
    if (!code) return fail("Google didn't return a code.");

    const res = await deps.fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: `${cfg.publicUrl}/auth/google/callback`,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }).toString(),
    });
    if (!res.ok) return fail(`Google rejected the sign-in (${res.status}).`);
    const idToken = ((await res.json()) as { id_token?: string }).id_token;
    let claims: { iss?: string; aud?: string; exp?: number; email?: string; email_verified?: boolean | string };
    try {
      claims = JSON.parse(fromB64url(idToken!.split(".")[1]!));
    } catch {
      return fail("Google's response couldn't be read.");
    }
    const email = claims.email?.toLowerCase();
    const verified = claims.email_verified === true || claims.email_verified === "true";
    if (!GOOGLE_ISSUERS.has(claims.iss ?? "") || claims.aud !== cfg.clientId || (claims.exp ?? 0) <= nowS(deps.clock)) {
      return fail("Google's sign-in token wasn't valid for this app.");
    }
    if (!email || !verified) return fail("Your Google account's email isn't verified.");
    if (!cfg.allowedEmails.includes(email)) {
      return c.html(page("Not authorised", `<p>${escapeHtml(email)} isn't allowed to use this app.</p>`), 403);
    }
    setSession(c, deps, email);
    return c.redirect("/");
  });

  app.get("/dev", (c) => {
    if (!deps.devEmail || !deps.sessionSecret) return c.json({ error: "Not found" }, 404);
    setSession(c, deps, deps.devEmail);
    // Dev only: land on a given page (same-site paths only), so browser checks can open any screen signed in.
    const next = c.req.query("next") ?? "/";
    return c.redirect(next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/");
  });

  app.get("/me", (c) => {
    const email = readSession(c, deps);
    if (email) return c.json({ email });
    return c.json(
      { error: "Not signed in", google: deps.config ? "enabled" : "disabled", dev_login: deps.devEmail ? "enabled" : "disabled" },
      401,
    );
  });

  app.post("/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  return app;
}
