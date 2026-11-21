import { join } from "node:path";
import type { DB } from "./db.ts";

/** Shape of a row in free-exercise-db's dist/exercises.json (checked against the real file). */
export type SourceExercise = {
  id: string;
  name: string;
  force: string | null;
  level: string;
  mechanic: string | null;
  equipment: string | null;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  instructions: string[];
  category: string;
  images: string[];
};

export const DATA_PATH = join(import.meta.dir, "..", "data", "exercises.json");

/**
 * free-exercise-db has no "type" (which fields a set uses), so infer one. Wrong guesses
 * can be fixed with PATCH /api/exercises/:id, which marks the row so refresh keeps the fix.
 */
export function deriveType(e: SourceExercise): string {
  const name = e.name.toLowerCase();
  if (e.category === "cardio") return "distance_duration";
  if (e.category === "stretching") return "duration";
  if (e.equipment === "body only") {
    if (/\bassisted\b/.test(name)) return "bodyweight_assisted_reps";
    if (e.force === "static" || /\b(plank|hold|hang|l-sit|wall sit)\b/.test(name)) return "duration";
    return "bodyweight_reps";
  }
  if (/\bassisted\b/.test(name) && e.equipment === "machine") return "bodyweight_assisted_reps";
  if (/\b(farmer|yoke|sled|prowler)\b/.test(name)) return "short_distance_weight";
  return "weight_reps";
}

export function mapSourceExercise(e: SourceExercise) {
  return {
    id: e.id,
    name: e.name,
    type: deriveType(e),
    category: e.category ?? null,
    force: e.force ?? null,
    level: e.level ?? null,
    mechanic: e.mechanic ?? null,
    equipment: e.equipment ?? null,
    primary_muscles: JSON.stringify(e.primaryMuscles ?? []),
    secondary_muscles: JSON.stringify(e.secondaryMuscles ?? []),
    instructions: JSON.stringify(e.instructions ?? []),
    images: JSON.stringify(e.images ?? []),
  };
}

export async function loadSourceExercises(path = DATA_PATH): Promise<SourceExercise[]> {
  return (await Bun.file(path).json()) as SourceExercise[];
}

const COLS = "id, name, type, category, force, level, mechanic, equipment, primary_muscles, secondary_muscles, instructions, images";
const VALS = "$id, $name, $type, $category, $force, $level, $mechanic, $equipment, $primary_muscles, $secondary_muscles, $instructions, $images";

/**
 * Insert library exercises in one transaction.
 * - default: INSERT OR IGNORE (idempotent, never changes existing rows)
 * - refresh: upsert library rows from the latest dataset; custom exercises, logged sets
 *   and manual `type` overrides are left alone. Nothing is ever deleted (sets reference ids).
 */
export function seedExercises(db: DB, source: SourceExercise[], opts: { refresh?: boolean } = {}) {
  const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM exercises WHERE is_custom = 0").get()!.n;
  const stmt = opts.refresh
    ? db.query(
        `INSERT INTO exercises (${COLS}) VALUES (${VALS})
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           type = CASE WHEN exercises.type_overridden = 1 THEN exercises.type ELSE excluded.type END,
           category = excluded.category, force = excluded.force, level = excluded.level,
           mechanic = excluded.mechanic, equipment = excluded.equipment,
           primary_muscles = excluded.primary_muscles, secondary_muscles = excluded.secondary_muscles,
           instructions = excluded.instructions, images = excluded.images
         WHERE exercises.is_custom = 0`,
      )
    : db.query(`INSERT OR IGNORE INTO exercises (${COLS}) VALUES (${VALS})`);
  db.transaction(() => {
    for (const e of source) stmt.run(mapSourceExercise(e));
  })();
  const after = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM exercises WHERE is_custom = 0").get()!.n;
  return { inserted: after - before, total: after };
}

/** Boot-time seed: only runs when there are no library exercises yet. */
export async function seedIfEmpty(db: DB, path = DATA_PATH) {
  const n = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM exercises WHERE is_custom = 0").get()!.n;
  if (n > 0) return null;
  return seedExercises(db, await loadSourceExercises(path));
}

// CLI: `bun run seed` (seed if empty) or `bun run seed --refresh` (upsert latest dataset).
if (import.meta.main) {
  const { openDb, migrate } = await import("./db.ts");
  const db = openDb(process.env.DB_PATH ?? "./data/gym.db");
  migrate(db);
  const refresh = process.argv.includes("--refresh");
  const result = refresh ? seedExercises(db, await loadSourceExercises(), { refresh: true }) : await seedIfEmpty(db);
  console.log(result ? `Seeded: ${JSON.stringify(result)}` : "Library already seeded (use --refresh to update)");
  db.close();
}
