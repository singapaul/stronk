import { z } from "zod";

/** Shared by REST validation and MCP tool input schemas. */

export const EXERCISE_TYPES = [
  "weight_reps",
  "reps_only",
  "bodyweight_reps",
  "bodyweight_assisted_reps",
  "duration",
  "weight_duration",
  "distance_duration",
  "short_distance_weight",
] as const;
export const SET_TYPES = ["warmup", "normal", "failure", "dropset"] as const;
export const LEVELS = ["beginner", "intermediate", "expert"] as const;

export const ExerciseType = z.enum(EXERCISE_TYPES);
export const SetType = z.enum(SET_TYPES);
export const IsoDate = z.iso.date({ error: "Expected a date as YYYY-MM-DD" });

/** Query strings arrive as strings; numeric fields are coerced. */
const limit = (dflt: number, max: number) => z.coerce.number().int().min(1).max(max).default(dflt);
const offset = z.coerce.number().int().min(0).default(0);

// ---------- Exercises ----------

export const ExerciseSearchInput = z.object({
  query: z.string().trim().min(1).optional().describe("Free text: name, muscle or equipment words, e.g. 'incline db press'"),
  muscle: z.string().trim().min(1).optional().describe("Primary muscle, e.g. chest, lats, quadriceps, 'middle back'"),
  equipment: z.string().trim().min(1).optional().describe("e.g. barbell, dumbbell, cable, machine, 'body only', kettlebells"),
  level: z.enum(LEVELS).optional(),
  category: z.string().trim().min(1).optional().describe("strength, powerlifting, stretching, cardio, plyometrics, ..."),
  type: ExerciseType.optional(),
  limit: limit(10, 100),
  offset,
});
export type ExerciseSearchInput = z.infer<typeof ExerciseSearchInput>;

const muscleList = z.array(z.string().trim().toLowerCase().min(1)).max(10);

export const CustomExerciseInput = z.object({
  name: z.string().trim().min(2).max(100),
  primary_muscles: muscleList.min(1),
  secondary_muscles: muscleList.default([]),
  type: ExerciseType.default("weight_reps"),
  equipment: z.string().trim().toLowerCase().min(1).optional(),
  category: z.string().trim().toLowerCase().min(1).default("strength"),
  level: z.enum(LEVELS).optional(),
  force: z.enum(["push", "pull", "static"]).optional(),
  mechanic: z.enum(["compound", "isolation"]).optional(),
  instructions: z.array(z.string().trim().min(1)).max(30).default([]),
});
export type CustomExerciseInput = z.infer<typeof CustomExerciseInput>;

export const ExercisePatch = CustomExerciseInput.partial()
  .extend({
    // `.partial()` keeps the defaults; strip them so a PATCH only touches what was sent.
    secondary_muscles: muscleList.optional(),
    type: ExerciseType.optional(),
    category: z.string().trim().toLowerCase().min(1).optional(),
    instructions: z.array(z.string().trim().min(1)).max(30).optional(),
  })
  .refine((p) => Object.keys(p).length > 0, "Nothing to update");
export type ExercisePatch = z.infer<typeof ExercisePatch>;
