import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/**
 * REST routes and MCP tools must call the shared functions in src/services/ rather than touching
 * the database themselves, so both surfaces behave identically. SQL lives in src/services/,
 * src/db.ts and src/seed.ts only.
 */
const SURFACES = ["src/routes/**/*.ts", "src/mcp/**/*.ts", "src/openapi/**/*.ts", "src/app.ts", "src/auth.ts"];
const DB_CALL = /\bdb\.(query|run|exec|prepare|transaction)\s*\(/;

describe("architecture", () => {
  test("only services touch the database", async () => {
    const offenders: string[] = [];
    for (const pattern of SURFACES) {
      for await (const file of new Glob(pattern).scan(".")) {
        const lines = (await Bun.file(file).text()).split("\n");
        lines.forEach((line, i) => {
          if (DB_CALL.test(line)) offenders.push(`${file}:${i + 1}  ${line.trim()}`);
        });
      }
    }
    expect(offenders, "Move these queries into a function in src/services/ and call it from here").toEqual([]);
  });
});
