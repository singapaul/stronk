/** Download free-exercise-db (public domain, Unlicense) into data/exercises.json. Run at build time, then commit the file. */
const SOURCE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json";
const out = new URL("../data/exercises.json", import.meta.url);

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
const data = (await res.json()) as unknown[];
if (!Array.isArray(data) || data.length < 100) throw new Error("Unexpected dataset shape");
await Bun.write(out, JSON.stringify(data, null, 2) + "\n");
console.log(`Wrote ${data.length} exercises to ${out.pathname}`);
