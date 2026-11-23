import { z } from "zod";

const token = (name: string) =>
  z.string({ error: `${name} is required` }).min(32, `${name} must be at least 32 characters`);

const EnvSchema = z.object({
  BASIC_AUTH_USER: z.string({ error: "BASIC_AUTH_USER is required" }).min(1, "BASIC_AUTH_USER is required"),
  BASIC_AUTH_PASS: z.string({ error: "BASIC_AUTH_PASS is required" }).min(1, "BASIC_AUTH_PASS is required"),
  MCP_TOKEN: token("MCP_TOKEN"),
  MCP_PATH_TOKEN: token("MCP_PATH_TOKEN"),
  // Optional token for phone health sync (POST /api/bodyweight/import). Unset: that route takes basic auth only.
  // An empty value (as in .env.example) counts as unset.
  INGEST_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), token("INGEST_TOKEN").optional()),
  DB_PATH: z.string().default("./data/gym.db"),
  PORT: z.coerce.number().int().positive().default(3000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW_S: z.coerce.number().int().positive().default(300),
  // Web app sign-in (all five, or none: without them the web app's Google sign-in is disabled).
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  ALLOWED_EMAILS: z.string().min(3).optional(),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters").optional(),
  PUBLIC_URL: z.url({ error: "PUBLIC_URL must be a URL, e.g. https://stronk.fly.dev" }).optional(),
  // Local-only sign-in shortcut for development and browser testing; ignored when NODE_ENV=production.
  DEV_LOGIN_EMAIL: z.email().optional(),
  NODE_ENV: z.string().optional(),
});

const WEB_AUTH_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ALLOWED_EMAILS", "SESSION_SECRET", "PUBLIC_URL"] as const;

export type Env = z.infer<typeof EnvSchema>;

/** Parse env vars, throwing a readable error listing every problem. The app refuses to start on failure. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${problems}`);
  }
  if (parsed.data.MCP_TOKEN === parsed.data.MCP_PATH_TOKEN) {
    throw new Error("Invalid environment:\n  - MCP_TOKEN and MCP_PATH_TOKEN must differ");
  }
  const ingest = parsed.data.INGEST_TOKEN;
  if (ingest && (ingest === parsed.data.MCP_TOKEN || ingest === parsed.data.MCP_PATH_TOKEN)) {
    throw new Error("Invalid environment:\n  - INGEST_TOKEN must differ from MCP_TOKEN and MCP_PATH_TOKEN");
  }
  const set = WEB_AUTH_KEYS.filter((k) => parsed.data[k] !== undefined);
  if (set.length > 0 && set.length < WEB_AUTH_KEYS.length) {
    const missing = WEB_AUTH_KEYS.filter((k) => parsed.data[k] === undefined);
    throw new Error(`Invalid environment:\n  - web sign-in is partly configured; also set ${missing.join(", ")} (or unset ${set.join(", ")})`);
  }
  return parsed.data;
}

export type WebAuthConfig = {
  clientId: string;
  clientSecret: string;
  allowedEmails: string[];
  sessionSecret: string;
  publicUrl: string;
};

/** Google sign-in settings, or null when the web app's sign-in isn't configured. */
export function webAuthConfig(env: Env): WebAuthConfig | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.ALLOWED_EMAILS || !env.SESSION_SECRET || !env.PUBLIC_URL) return null;
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    allowedEmails: env.ALLOWED_EMAILS.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
    sessionSecret: env.SESSION_SECRET,
    publicUrl: env.PUBLIC_URL.replace(/\/+$/, ""),
  };
}

/** The dev sign-in email, only outside production. */
export const devLoginEmail = (env: Env): string | null =>
  env.NODE_ENV !== "production" && env.DEV_LOGIN_EMAIL ? env.DEV_LOGIN_EMAIL.toLowerCase() : null;
