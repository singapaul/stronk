import { createApp } from "./app.ts";
import { migrate, openDb } from "./db.ts";
import { loadEnv } from "./env.ts";
import { seedIfEmpty } from "./seed.ts";

const env = loadEnv();
const db = openDb(env.DB_PATH);
const applied = migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
const seeded = await seedIfEmpty(db);
if (seeded) console.log(`Seeded ${seeded.inserted} exercises`);

const app = createApp({ db, env });
console.log(`Listening on :${env.PORT}`);

export default { port: env.PORT, fetch: app.fetch };
