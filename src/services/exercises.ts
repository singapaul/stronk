import type { DB } from "../db.ts";
import { conflict, notFound } from "../errors.ts";
import type { CustomExerciseInput, ExercisePatch, ExerciseSearchInput } from "../schemas.ts";

export const IMAGE_BASE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises/";

export type ExerciseRow = {
  id: string;
  name: string;
  type: string;
  type_overridden: number;
  category: string | null;
  force: string | null;
  level: string | null;
  mechanic: string | null;
  equipment: string | null;
  primary_muscles: string;
  secondary_muscles: string;
  instructions: string;
  images: string;
  is_custom: number;
  created_at: string;
  updated_at: string;
};

export type Exercise = ReturnType<typeof toExercise>;

/** Image paths are stored relative; URLs are built here so the CDN base can change without a migration. */
export function toExercise(r: ExerciseRow) {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    category: r.category,
    force: r.force,
    level: r.level,
    mechanic: r.mechanic,
    equipment: r.equipment,
    primary_muscles: JSON.parse(r.primary_muscles) as string[],
    secondary_muscles: JSON.parse(r.secondary_muscles) as string[],
    instructions: JSON.parse(r.instructions) as string[],
    images: (JSON.parse(r.images) as string[]).map((p) => IMAGE_BASE + p),
    is_custom: r.is_custom === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export type ExerciseSummary = {
  id: string;
  name: string;
  type: string;
  equipment: string | null;
  level: string | null;
  category: string | null;
  primary_muscles: string[];
  times_logged: number;
};

type SummaryRow = Pick<ExerciseRow, "id" | "name" | "type" | "equipment" | "level" | "category" | "primary_muscles"> & {
  times_logged: number;
};

const toSummary = (r: SummaryRow): ExerciseSummary => ({
  id: r.id,
  name: r.name,
  type: r.type,
  equipment: r.equipment,
  level: r.level,
  category: r.category,
  primary_muscles: JSON.parse(r.primary_muscles),
  times_logged: r.times_logged,
});

/** Words → an FTS5 query of quoted prefix terms. Quoting neutralises FTS operators in user input. */
function ftsQuery(text: string, op: "AND" | "OR"): string | null {
  const words = text
    .toLowerCase()
    .replace(/_/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
  if (words.length === 0) return null;
  return words.map((w) => `"${w}"*`).join(` ${op} `);
}

const normMuscle = (m: string) => m.trim().toLowerCase().replace(/_/g, " ");

/** Performed-set counts per exercise, so the lifts I actually do rank first. */
const USAGE_JOIN = `
  LEFT JOIN (
    SELECT we.exercise_id, COUNT(*) AS n
    FROM sets s JOIN workout_exercises we ON we.id = s.workout_exercise_id
    WHERE s.is_planned = 0
    GROUP BY we.exercise_id
  ) u ON u.exercise_id = e.id`;

export function searchExercises(db: DB, input: ExerciseSearchInput): { total: number; results: ExerciseSummary[] } {
  const run = (match: string | null) => {
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    let from = "exercises e";
    if (match) {
      from = "exercises_fts f JOIN exercises e ON e.rowid = f.rowid";
      where.push("exercises_fts MATCH $match");
      params.match = match;
    }
    if (input.muscle) {
      where.push("EXISTS (SELECT 1 FROM json_each(e.primary_muscles) WHERE value = $muscle)");
      params.muscle = normMuscle(input.muscle);
    }
    if (input.equipment) {
      where.push("lower(e.equipment) = $equipment");
      params.equipment = input.equipment.toLowerCase().replace(/_/g, " ");
    }
    if (input.level) {
      where.push("e.level = $level");
      params.level = input.level;
    }
    if (input.category) {
      where.push("lower(e.category) = $category");
      params.category = input.category.toLowerCase();
    }
    if (input.type) {
      where.push("e.type = $type");
      params.type = input.type;
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const order = match ? "times_logged DESC, bm25(exercises_fts, 10.0, 2.0, 1.0), e.name" : "times_logged DESC, e.name";
    const total = db
      .query<{ n: number }, Record<string, string | number>>(`SELECT COUNT(*) AS n FROM ${from} ${whereSql}`)
      .get(params)!.n;
    const rows = db
      .query<SummaryRow, Record<string, string | number>>(
        `SELECT e.id, e.name, e.type, e.equipment, e.level, e.category, e.primary_muscles,
                COALESCE(u.n, 0) AS times_logged
         FROM ${from} ${USAGE_JOIN} ${whereSql}
         ORDER BY ${order} LIMIT $limit OFFSET $offset`,
      )
      .all({ ...params, limit: input.limit, offset: input.offset });
    return { total, results: rows.map(toSummary) };
  };

  if (!input.query) return run(null);
  const strict = run(ftsQuery(input.query, "AND"));
  if (strict.total > 0) return strict;
  // Nothing matched every word: loosen to any word rather than returning nothing.
  return run(ftsQuery(input.query, "OR"));
}

/** Closest matches for an unknown id, so a caller (often Claude) can retry with a real one. */
export function suggestExercises(db: DB, idOrName: string, limit = 5) {
  const search = (query: string) =>
    searchExercises(db, { query, limit, offset: 0 }).results.map((r) => ({ id: r.id, name: r.name }));
  const exact = search(idOrName);
  if (exact.length > 0) return exact;
  // Typo tolerance: retry with each word cut to a 4-letter stem ("benchh" → "benc*").
  const stems = idOrName
    .replace(/_/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4)
    .map((w) => w.slice(0, 4));
  return stems.length ? search(stems.join(" ")) : [];
}

export function findExerciseRow(db: DB, id: string): ExerciseRow | null {
  return db.query<ExerciseRow, [string]>("SELECT * FROM exercises WHERE id = ?").get(id);
}

/** Load an exercise or throw 404 with the top 5 suggestions. Every write that takes an exercise_id goes through this. */
export function requireExercise(db: DB, id: string): ExerciseRow {
  const row = findExerciseRow(db, id);
  if (!row) {
    throw notFound(`Exercise '${id}'`, {
      hint: "Use one of these ids, or search_exercises to find the right one",
      suggestions: suggestExercises(db, id),
    });
  }
  return row;
}

export function getExercise(db: DB, id: string): Exercise {
  return toExercise(requireExercise(db, id));
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

export function createCustomExercise(db: DB, input: CustomExerciseInput): Exercise {
  const id = `custom_${slugify(input.name)}`;
  const existing = findExerciseRow(db, id);
  if (existing) throw conflict(`Custom exercise '${input.name}' already exists`, { id });
  db.query(
    `INSERT INTO exercises (id, name, type, type_overridden, category, force, level, mechanic, equipment,
       primary_muscles, secondary_muscles, instructions, images, is_custom)
     VALUES ($id, $name, $type, 1, $category, $force, $level, $mechanic, $equipment,
       $primary, $secondary, $instructions, '[]', 1)`,
  ).run({
    id,
    name: input.name,
    type: input.type,
    category: input.category,
    force: input.force ?? null,
    level: input.level ?? null,
    mechanic: input.mechanic ?? null,
    equipment: input.equipment ?? null,
    primary: JSON.stringify(input.primary_muscles.map(normMuscle)),
    secondary: JSON.stringify(input.secondary_muscles.map(normMuscle)),
    instructions: JSON.stringify(input.instructions),
  });
  return getExercise(db, id);
}

/**
 * Library exercises only accept a `type` override (it survives `seed --refresh`).
 * Custom exercises accept any field.
 */
export function updateExercise(db: DB, id: string, patch: ExercisePatch): Exercise {
  const row = requireExercise(db, id);
  const keys = Object.keys(patch) as (keyof ExercisePatch)[];
  if (row.is_custom === 0) {
    const disallowed = keys.filter((k) => k !== "type");
    if (disallowed.length) {
      throw conflict("Library exercises only allow changing `type`; create a custom exercise instead", {
        disallowed,
      });
    }
  }
  const sets: string[] = [];
  const params: Record<string, string | number | null> = { id };
  const json = new Set(["primary_muscles", "secondary_muscles", "instructions"]);
  for (const k of keys) {
    const v = patch[k];
    if (v === undefined) continue;
    sets.push(`${k} = $${k}`);
    params[k] = json.has(k)
      ? JSON.stringify(k === "instructions" ? v : (v as string[]).map(normMuscle))
      : (v as string);
  }
  if (patch.type) sets.push("type_overridden = 1");
  db.query(`UPDATE exercises SET ${sets.join(", ")} WHERE id = $id`).run(params);
  return getExercise(db, id);
}
