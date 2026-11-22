/** Regenerate src/openapi/examples.json from a scripted session (see src/openapi/example-scenario.ts). */
import { runExampleScenario } from "../src/openapi/example-scenario.ts";

const out = new URL("../src/openapi/examples.json", import.meta.url);
const examples = await runExampleScenario();
const sorted = Object.fromEntries(Object.entries(examples).sort(([a], [b]) => a.localeCompare(b)));
await Bun.write(out, JSON.stringify(sorted, null, 2) + "\n");
console.log(`Wrote ${Object.keys(sorted).length} examples to ${out.pathname}`);
