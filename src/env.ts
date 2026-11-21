import { z } from "zod";

const token = (name: string) =>
  z.string({ error: `${name} is required` }).min(32, `${name} must be at least 32 characters`);

const EnvSchema = z.object({
  BASIC_AUTH_USER: z.string({ error: "BASIC_AUTH_USER is required" }).min(1, "BASIC_AUTH_USER is required"),
  BASIC_AUTH_PASS: z.string({ error: "BASIC_AUTH_PASS is required" }).min(1, "BASIC_AUTH_PASS is required"),
  MCP_TOKEN: token("MCP_TOKEN"),
  MCP_PATH_TOKEN: token("MCP_PATH_TOKEN"),
  DB_PATH: z.string().default("./data/gym.db"),
  PORT: z.coerce.number().int().positive().default(3000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW_S: z.coerce.number().int().positive().default(300),
});

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
  return parsed.data;
}
