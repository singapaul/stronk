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

// ---------- Sets & workouts ----------
// Plain objects (no .refine) so the shapes can be reused as MCP tool input schemas.
// Cross-field rules (e.g. "reps, duration or distance") are enforced in services.

const reps = z.number().int().min(0).max(1000);
const weightKg = z.number().min(-200).max(1000).describe("kg. Bodyweight exercises: added load (negative = assistance)");
const rpe = z.number().min(1).max(10).multipleOf(0.5);
const durationS = z.number().int().min(0).max(86_400);
const distanceM = z.number().min(0).max(1_000_000);
const notes = z.string().trim().max(1000);
const id = z.coerce.number().int().positive();
const DateTime = z.iso.datetime({ offset: true, error: "Expected an ISO datetime, e.g. 2026-03-10T18:00:00Z" });

export const PerformedSetFields = {
  type: SetType.optional().describe("warmup | normal (default) | failure | dropset"),
  reps: reps.optional(),
  weight_kg: weightKg.optional(),
  duration_s: durationS.optional(),
  distance_m: distanceM.optional(),
  rpe: rpe.optional(),
  notes: notes.optional(),
};
export const PerformedSet = z.object(PerformedSetFields);
export type PerformedSet = z.infer<typeof PerformedSet>;

export const LogSetShape = {
  exercise_id: z.string().min(1).describe("Exact exercise id from search_exercises"),
  ...PerformedSetFields,
  workout_id: id.optional().describe("Defaults to the workout for `date`"),
  date: IsoDate.optional().describe("Training day YYYY-MM-DD; defaults to today (Europe/London, day rolls over at 04:00)"),
};
export const LogSetInput = z.object(LogSetShape);
export type LogSetInput = z.infer<typeof LogSetInput>;

export const BlockFields = {
  notes: notes.optional(),
  superset_group: z.number().int().min(1).max(50).optional().describe("Blocks sharing a number form a superset"),
  rest_seconds: z.number().int().min(0).max(3600).optional(),
};

export const LogWorkoutShape = {
  date: IsoDate.optional(),
  name: z.string().trim().min(1).max(100).optional(),
  notes: notes.optional(),
  start_time: DateTime.optional(),
  end_time: DateTime.optional(),
  exercises: z
    .array(z.object({ exercise_id: z.string().min(1), ...BlockFields, sets: z.array(PerformedSet).min(1).max(50) }))
    .min(1)
    .max(30),
};
export const LogWorkoutInput = z.object(LogWorkoutShape);
export type LogWorkoutInput = z.infer<typeof LogWorkoutInput>;

export const PlannedSetFields = {
  type: SetType.optional(),
  reps: reps.optional().describe("Exact target reps (shorthand for reps_min = reps_max)"),
  reps_min: reps.optional(),
  reps_max: reps.optional(),
  weight_kg: weightKg.optional(),
  rpe: rpe.optional(),
  duration_s: durationS.optional(),
  distance_m: distanceM.optional(),
  notes: notes.optional(),
};
export const PlannedSet = z.object(PlannedSetFields);
export type PlannedSet = z.infer<typeof PlannedSet>;

export const PlanBlock = z.object({ exercise_id: z.string().min(1), ...BlockFields, sets: z.array(PlannedSet).min(1).max(50) });
export type PlanBlock = z.infer<typeof PlanBlock>;

export const PlanSessionShape = {
  date: IsoDate.optional(),
  name: z.string().trim().min(1).max(100),
  notes: notes.optional(),
  exercises: z.array(PlanBlock).min(1).max(30),
};
export const PlanSessionInput = z.object(PlanSessionShape);
export type PlanSessionInput = z.infer<typeof PlanSessionInput>;

export const CompletePlannedSetShape = { set_id: id, ...PerformedSetFields };
export const CompletePlannedSetInput = z.object(CompletePlannedSetShape);
export type CompletePlannedSetInput = z.infer<typeof CompletePlannedSetInput>;

/** null clears a field. */
export const SetPatchFields = {
  type: SetType.optional(),
  reps: reps.nullable().optional(),
  weight_kg: weightKg.nullable().optional(),
  duration_s: durationS.nullable().optional(),
  distance_m: distanceM.nullable().optional(),
  rpe: rpe.nullable().optional(),
  notes: notes.nullable().optional(),
  target_reps_min: reps.nullable().optional(),
  target_reps_max: reps.nullable().optional(),
  target_weight_kg: weightKg.nullable().optional(),
  target_rpe: rpe.nullable().optional(),
};
export const SetPatch = z.object(SetPatchFields);
export type SetPatch = z.infer<typeof SetPatch>;

export const WorkoutPatch = z.object({
  date: IsoDate.optional(),
  name: z.string().trim().min(1).max(100).nullable().optional(),
  notes: notes.nullable().optional(),
  start_time: DateTime.nullable().optional(),
  end_time: DateTime.nullable().optional(),
});
export type WorkoutPatch = z.infer<typeof WorkoutPatch>;

export const BlockPatch = z.object({
  notes: notes.nullable().optional(),
  superset_group: z.number().int().min(1).max(50).nullable().optional(),
  rest_seconds: z.number().int().min(0).max(3600).nullable().optional(),
  position: z.number().int().min(1).optional(),
});
export type BlockPatch = z.infer<typeof BlockPatch>;

export const WorkoutListInput = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  updated_since: DateTime.optional(),
  limit: limit(20, 100),
  offset,
});
export type WorkoutListInput = z.infer<typeof WorkoutListInput>;

// ---------- Routines ----------

export const RoutineShape = {
  name: z.string().trim().min(1).max(100),
  notes: notes.optional(),
  exercises: z.array(PlanBlock).min(1).max(30).describe("Blocks in order; sets use reps or reps_min/reps_max as targets"),
};
export const RoutineInput = z.object(RoutineShape);
export type RoutineInput = z.infer<typeof RoutineInput>;

export const RoutinePatchShape = {
  name: z.string().trim().min(1).max(100).optional(),
  notes: notes.nullable().optional(),
  exercises: z.array(PlanBlock).min(1).max(30).optional().describe("Replaces all blocks when given"),
};
export const RoutinePatch = z.object(RoutinePatchShape);
export type RoutinePatch = z.infer<typeof RoutinePatch>;

export const StartRoutineInput = z.object({ date: IsoDate.optional() });

// ---------- Bodyweight ----------

export const BodyweightFields = {
  weight_kg: z.number().min(20).max(400),
  fat_percent: z.number().min(1).max(70).optional(),
  notes: notes.optional(),
};
export const BodyweightInput = z.object(BodyweightFields);
export type BodyweightInput = z.infer<typeof BodyweightInput>;

export const BodyweightListInput = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  limit: limit(30, 365),
});
export type BodyweightListInput = z.infer<typeof BodyweightListInput>;
