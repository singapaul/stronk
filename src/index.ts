import { createApp } from "./app.ts";
import { migrate, openDb } from "./db.ts";
import { loadEnv } from "./env.ts";

const env = loadEnv();
const db = openDb(env.DB_PATH);
const applied = migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);

const app = createApp({ db, env });
console.log(`Listening on :${env.PORT}`);

export default { port: env.PORT, fetch: app.fetch };
