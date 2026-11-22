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
/** JSON ids (bodies and MCP inputs). Path params are coerced in routes. */
const id = z.number().int().positive();
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
  fill_planned: z
    .boolean()
    .optional()
    .describe("Default true: fill the next planned set for this exercise if one is waiting. false always adds a new set"),
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

// ---------- Stats ----------

export const HistoryInput = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  format: z.enum(["sessions", "sets"]).default("sessions"),
});
export const SummaryInput = z.object({ from: IsoDate.optional(), to: IsoDate.optional() });
export const RecentInput = z.object({ days: z.coerce.number().int().min(1).max(365).default(14) });

// ---------- REST-only shapes (also used by the OpenAPI spec) ----------

/** REST allows creating an empty workout; MCP's log_workout requires sets. */
export const CreateWorkoutInput = LogWorkoutInput.extend({
  exercises: LogWorkoutInput.shape.exercises.min(0).default([]),
});

/** REST search uses ?q= for the free-text query. */
export const ExerciseSearchQuery = ExerciseSearchInput.omit({ query: true }).extend({
  q: ExerciseSearchInput.shape.query,
});

export const PrsQuery = z.object({
  exercise_id: z.string().min(1).optional().describe("Limit to one exercise"),
});

/** Body for POST /api/sets/:id/complete (the set id comes from the path). */
export const CompleteSetBody = PerformedSet;

// ---------- Programs & cycles ----------

const routineIds = z
  .array(z.number().int().positive())
  .min(1)
  .max(14)
  .describe("Routine ids in the order they're run; one pass through the list is a cycle");

export const ProgramShape = {
  name: z.string().trim().min(1).max(100),
  notes: notes.optional(),
  routine_ids: routineIds,
  activate: z.boolean().default(true).describe("Make this the active program (deactivates any other)"),
};
export const ProgramInput = z.object(ProgramShape);
export type ProgramInput = z.infer<typeof ProgramInput>;

export const ProgramPatchShape = {
  name: z.string().trim().min(1).max(100).optional(),
  notes: notes.nullable().optional(),
  routine_ids: routineIds.optional().describe("Replaces the slots; only allowed before any workout of the program has started"),
  active: z.boolean().optional(),
};
export const ProgramPatch = z.object(ProgramPatchShape);
export type ProgramPatch = z.infer<typeof ProgramPatch>;

export const NextWorkoutInput = z.object({
  date: IsoDate.optional().describe("Training day to plan it on; defaults to today"),
});

export const SkipSlotInput = z.object({
  slot_position: z.number().int().min(1).optional().describe("Defaults to the next slot due"),
});

export const ReviewCycleQuery = z.object({
  cycle_number: z.coerce.number().int().min(1).optional().describe("Defaults to the latest completed cycle"),
});

export const CycleTargetSet = z.object({
  type: SetType.optional(),
  reps: reps.optional().describe("Exact target reps (shorthand for reps_min = reps_max)"),
  reps_min: reps.optional(),
  reps_max: reps.optional(),
  weight_kg: weightKg.optional(),
  rpe: rpe.optional(),
  duration_s: durationS.optional(),
  distance_m: distanceM.optional(),
});
export type CycleTargetSet = z.infer<typeof CycleTargetSet>;

export const SetCycleTargetsShape = {
  cycle_number: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Defaults to the latest cycle if it's unfinished, otherwise a new next cycle"),
  notes: notes.optional().describe("Why these targets, e.g. the progression applied"),
  slots: z
    .array(
      z.object({
        slot_position: z.number().int().min(1),
        exercises: z
          .array(
            z.object({
              exercise_id: z.string().min(1),
              sets: z.array(CycleTargetSet).min(1).max(20).describe("Replaces this exercise's target sets, in order"),
            }),
          )
          .min(1),
      }),
    )
    .min(1)
    .describe("Only the slots and exercises listed change; everything else carries over"),
};
export const SetCycleTargetsInput = z.object(SetCycleTargetsShape);
export type SetCycleTargetsInput = z.infer<typeof SetCycleTargetsInput>;
