import type { z } from "zod";
import {
  BlockPatch,
  BodyweightInput,
  BodyweightListInput,
  CompleteSetBody,
  CreateWorkoutInput,
  CustomExerciseInput,
  ExercisePatch,
  ExerciseSearchQuery,
  HistoryInput,
  LogSetInput,
  NextWorkoutInput,
  ProgramInput,
  ProgramPatch,
  ReviewCycleQuery,
  SetCycleTargetsInput,
  SkipSlotInput,
  PlanSessionInput,
  PrsQuery,
  RecentInput,
  RoutineInput,
  RoutinePatch,
  SetPatch,
  StartRoutineInput,
  SummaryInput,
  WorkoutListInput,
  WorkoutPatch,
} from "../schemas.ts";

/**
 * Every REST route, documented. Paths use Hono's `:param` form so a test can compare this list
 * with `app.routes`: adding a route without documenting it fails the build.
 */
export type ErrorStatus = 400 | 404 | 409;
export type DocRoute = {
  method: "get" | "post" | "patch" | "put" | "delete";
  path: string;
  tag: Tag;
  summary: string;
  description?: string;
  params?: Record<string, string>;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Success status and what it returns. */
  ok: { status: 200 | 201; description: string };
  /** Domain errors on top of the 401/429 every route can return. */
  errors?: ErrorStatus[];
};

export const TAGS = {
  Exercises: "The exercise library (free-exercise-db plus your custom exercises). Ids are exact strings: search first.",
  Workouts: "One workout per training day (Europe/London; the day rolls over at 04:00). Writing to a day that already has a workout merges into it.",
  Sets: "Log, complete, fix and delete sets. Logging with no workout goes to today's workout and fills the next planned set.",
  Routines: "Reusable templates (e.g. 'Push A') with target sets. Starting one copies it into a day as planned sets.",
  Programs:
    "An ordered list of routines run on repeat. One pass through the list is a cycle, and each cycle keeps its own target sets. Start workouts with next-workout; after a cycle, review it and set the next cycle's targets.",
  Bodyweight: "One entry per date. Used to give bodyweight exercises (pull-ups, dips) a real load.",
  Stats: "History, PRs and summaries. Working sets only: warm-ups and planned sets never count; dropsets don't count toward e1RM/heaviest.",
  MCP: "JSON-RPC endpoint for Claude. How to connect and the full tool list are in the description at the top of this page.",
} as const;
export type Tag = keyof typeof TAGS;

const id = { id: "Numeric id" };
const exerciseId = { id: "Exact exercise id, e.g. Barbell_Bench_Press_-_Medium_Grip" };
const date = { date: "Date as YYYY-MM-DD" };

export const DOC_ROUTES: DocRoute[] = [
  // ----- Exercises -----
  {
    method: "get",
    path: "/api/exercises",
    tag: "Exercises",
    summary: "Search exercises",
    description: "Full-text search plus filters. Exercises you've logged rank first (`times_logged`); stretches rank below lifts unless you search for them.",
    query: ExerciseSearchQuery,
    ok: { status: 200, description: "Matching exercises (compact)" },
    errors: [400],
  },
  {
    method: "get",
    path: "/api/exercises/:id",
    tag: "Exercises",
    summary: "Get an exercise",
    description: "Full detail including instructions and image URLs. Unknown ids return 404 with the 5 closest matches in `details.suggestions`.",
    params: exerciseId,
    ok: { status: 200, description: "Exercise detail" },
    errors: [404],
  },
  {
    method: "post",
    path: "/api/exercises",
    tag: "Exercises",
    summary: "Create a custom exercise",
    description: "The id is generated as `custom_<slug>` from the name.",
    body: CustomExerciseInput,
    ok: { status: 201, description: "The new exercise" },
    errors: [400, 409],
  },
  {
    method: "patch",
    path: "/api/exercises/:id",
    tag: "Exercises",
    summary: "Update an exercise",
    description: "Custom exercises: any field. Library exercises: `type` only, which then survives `seed --refresh`.",
    params: exerciseId,
    body: ExercisePatch,
    ok: { status: 200, description: "The updated exercise" },
    errors: [400, 404, 409],
  },

  // ----- Workouts -----
  {
    method: "get",
    path: "/api/workouts",
    tag: "Workouts",
    summary: "List workouts",
    description: "Newest first. `updated_since` returns only workouts changed after that instant (including set edits).",
    query: WorkoutListInput,
    ok: { status: 200, description: "Workout summaries" },
    errors: [400],
  },
  {
    method: "post",
    path: "/api/workouts",
    tag: "Workouts",
    summary: "Create or log a workout",
    description:
      "Creates the day's workout (default today) and optionally logs blocks of sets in one transaction. If the day already has a workout, sets are appended and name/notes only fill empty fields. Pass `start_time`/`end_time` for backfills.",
    body: CreateWorkoutInput,
    ok: { status: 201, description: "The workout plus any PRs set" },
    errors: [400, 404],
  },
  {
    method: "post",
    path: "/api/workouts/plan",
    tag: "Workouts",
    summary: "Plan a session",
    description: "Saves target sets (status `planned` until something is performed). Merges into an existing workout that day.",
    body: PlanSessionInput,
    ok: { status: 201, description: "The planned workout" },
    errors: [400, 404],
  },
  {
    method: "get",
    path: "/api/workouts/today",
    tag: "Workouts",
    summary: "Today's workout",
    ok: { status: 200, description: "Workout detail" },
    errors: [404],
  },
  {
    method: "get",
    path: "/api/workouts/by-date/:date",
    tag: "Workouts",
    summary: "Workout for a date",
    params: date,
    ok: { status: 200, description: "Workout detail" },
    errors: [400, 404],
  },
  {
    method: "get",
    path: "/api/workouts/:id",
    tag: "Workouts",
    summary: "Get a workout",
    description: "Blocks in order with every set. `status`, `start_time`, `end_time` and `duration_min` are derived; planned sets left on past days are marked `skipped`.",
    params: id,
    ok: { status: 200, description: "Workout detail" },
    errors: [404],
  },
  {
    method: "patch",
    path: "/api/workouts/:id",
    tag: "Workouts",
    summary: "Update a workout",
    description: "`null` clears a field. Moving to a date that already has a workout is a 409.",
    params: id,
    body: WorkoutPatch,
    ok: { status: 200, description: "Workout detail" },
    errors: [400, 404, 409],
  },
  {
    method: "delete",
    path: "/api/workouts/:id",
    tag: "Workouts",
    summary: "Delete a workout",
    description: "Deletes its blocks and sets too.",
    params: id,
    ok: { status: 200, description: "Deletion confirmation" },
    errors: [404],
  },
  {
    method: "patch",
    path: "/api/workout-exercises/:id",
    tag: "Workouts",
    summary: "Update an exercise block",
    description: "Notes, superset group, rest, or `position` (other blocks shift to make room). The id is `block_id` from a workout.",
    params: id,
    body: BlockPatch,
    ok: { status: 200, description: "Workout detail" },
    errors: [400, 404],
  },

  // ----- Sets -----
  {
    method: "post",
    path: "/api/sets",
    tag: "Sets",
    summary: "Log a set",
    description:
      "With no `workout_id`/`date` the set goes to today's workout (created if needed). If that exercise has planned sets of the same kind waiting, the lowest-numbered one is filled and its targets kept. Returns PR flags, the next planned set and type warnings.",
    body: LogSetInput,
    ok: { status: 201, description: "The set, where it was logged, PR flags and the next planned target" },
    errors: [400, 404],
  },
  {
    method: "post",
    path: "/api/sets/:id/complete",
    tag: "Sets",
    summary: "Complete a planned set",
    params: id,
    body: CompleteSetBody,
    ok: { status: 200, description: "The completed set" },
    errors: [400, 404, 409],
  },
  {
    method: "patch",
    path: "/api/sets/:id",
    tag: "Sets",
    summary: "Update a set",
    description: "Only the fields sent change; `null` clears a field.",
    params: id,
    body: SetPatch,
    ok: { status: 200, description: "The updated set" },
    errors: [400, 404],
  },
  {
    method: "delete",
    path: "/api/sets/:id",
    tag: "Sets",
    summary: "Delete a set",
    description: "Remaining sets in the block are renumbered; an empty block is removed.",
    params: id,
    ok: { status: 200, description: "Deletion confirmation" },
    errors: [404],
  },

  // ----- Routines -----
  { method: "get", path: "/api/routines", tag: "Routines", summary: "List routines", ok: { status: 200, description: "Routines with their exercises and when each was last done" } },
  {
    method: "post",
    path: "/api/routines",
    tag: "Routines",
    summary: "Create a routine",
    description: "Names are unique (case-insensitive). Each exercise appears once, with its target sets.",
    body: RoutineInput,
    ok: { status: 201, description: "Routine detail" },
    errors: [400, 404, 409],
  },
  { method: "get", path: "/api/routines/:id", tag: "Routines", summary: "Get a routine", params: id, ok: { status: 200, description: "Routine detail" }, errors: [404] },
  {
    method: "patch",
    path: "/api/routines/:id",
    tag: "Routines",
    summary: "Update a routine",
    description: "Name/notes change in place. Sending `exercises` replaces every block.",
    params: id,
    body: RoutinePatch,
    ok: { status: 200, description: "Routine detail" },
    errors: [400, 404, 409],
  },
  {
    method: "delete",
    path: "/api/routines/:id",
    tag: "Routines",
    summary: "Delete a routine",
    description: "Workouts started from it are kept (their `routine_id` is cleared).",
    params: id,
    ok: { status: 200, description: "Deletion confirmation" },
    errors: [404],
  },
  {
    method: "post",
    path: "/api/routines/:id/start",
    tag: "Routines",
    summary: "Start a routine",
    description: "Copies the routine into a day's workout (default today) as planned sets, merging with any workout already there.",
    params: id,
    body: StartRoutineInput,
    ok: { status: 201, description: "The planned workout" },
    errors: [400, 404],
  },

  // ----- Programs -----
  { method: "get", path: "/api/programs", tag: "Programs", summary: "List programs", ok: { status: 200, description: "Programs with their routines and current cycle number" } },
  {
    method: "post",
    path: "/api/programs",
    tag: "Programs",
    summary: "Create a program",
    description: "Slots follow `routine_ids` in order. Creates cycle 1 with the routines' targets. Active by default (deactivates any other program).",
    body: ProgramInput,
    ok: { status: 201, description: "Program detail with cycle 1" },
    errors: [400, 404, 409],
  },
  {
    method: "get",
    path: "/api/programs/current",
    tag: "Programs",
    summary: "Active program",
    description: "The current cycle (the earliest unfinished one): each slot's status (`pending`, `started`, `done`, `skipped`), its workout and its target sets.",
    ok: { status: 200, description: "Program detail" },
    errors: [404],
  },
  { method: "get", path: "/api/programs/:id", tag: "Programs", summary: "Get a program", params: id, ok: { status: 200, description: "Program detail" }, errors: [404] },
  {
    method: "patch",
    path: "/api/programs/:id",
    tag: "Programs",
    summary: "Update a program",
    description: "Rename, change notes, or switch the active program. `routine_ids` replaces the slots and is only allowed before any of the program's workouts has started.",
    params: id,
    body: ProgramPatch,
    ok: { status: 200, description: "Program detail" },
    errors: [400, 404, 409],
  },
  {
    method: "post",
    path: "/api/programs/next-workout",
    tag: "Programs",
    summary: "Start the next workout",
    description:
      "Plans the next slot of the current cycle onto a day (default today) with that cycle's targets; then log sets as usual. If the current cycle is complete, the next cycle is created first with targets carried over. A slot already planned is returned, not planned twice.",
    body: NextWorkoutInput,
    ok: { status: 200, description: "The cycle, slot and planned workout" },
    errors: [400, 404, 409],
  },
  {
    method: "post",
    path: "/api/programs/skip",
    tag: "Programs",
    summary: "Skip a slot",
    description: "Marks a slot of the current cycle skipped (default: the next one due) so the cycle can complete without it.",
    body: SkipSlotInput,
    ok: { status: 200, description: "The skipped slot and the cycle" },
    errors: [400, 404, 409],
  },
  {
    method: "get",
    path: "/api/programs/cycles/review",
    tag: "Programs",
    summary: "Review a cycle",
    description:
      "Per slot and lift: target vs performed sets, sets hit, whether the top of the rep range was hit on every set, RPE vs target, and best e1RM vs the previous cycle. Plus bodyweight change and ad-hoc workouts in the window. Defaults to the latest completed cycle.",
    query: ReviewCycleQuery,
    ok: { status: 200, description: "Cycle review" },
    errors: [400, 404],
  },
  {
    method: "put",
    path: "/api/programs/cycles/targets",
    tag: "Programs",
    summary: "Set cycle targets",
    description:
      "Partial update of a cycle's targets (default: the latest cycle if unfinished, otherwise a new next cycle). Each listed exercise's sets are replaced; everything else carries over. Slots that have started are locked (409); exercises must already be in the slot's routine.",
    body: SetCycleTargetsInput,
    ok: { status: 200, description: "The updated cycle" },
    errors: [400, 404, 409],
  },

  // ----- Bodyweight -----
  { method: "get", path: "/api/bodyweight", tag: "Bodyweight", summary: "Bodyweight history", query: BodyweightListInput, ok: { status: 200, description: "Entries newest first, latest entry and change over the range" }, errors: [400] },
  {
    method: "put",
    path: "/api/bodyweight/:date",
    tag: "Bodyweight",
    summary: "Record bodyweight",
    description: "One entry per date; writing again replaces it.",
    params: date,
    body: BodyweightInput,
    ok: { status: 200, description: "The entry" },
    errors: [400],
  },
  { method: "delete", path: "/api/bodyweight/:date", tag: "Bodyweight", summary: "Delete a bodyweight entry", params: date, ok: { status: 200, description: "Deletion confirmation" }, errors: [400, 404] },

  // ----- Stats -----
  {
    method: "get",
    path: "/api/exercises/:id/history",
    tag: "Stats",
    summary: "Exercise history",
    description: "Per session (default 10 sessions): sets, top set, volume, Epley e1RM and a one-line summary. `format=sets` returns a flat list of sets (default 50).",
    params: exerciseId,
    query: HistoryInput,
    ok: { status: 200, description: "History, newest first" },
    errors: [400, 404],
  },
  {
    method: "get",
    path: "/api/prs",
    tag: "Stats",
    summary: "Personal records",
    description: "Per exercise: heaviest set, best estimated 1RM, best reps at each load, and longest duration/distance where relevant.",
    query: PrsQuery,
    ok: { status: 200, description: "Records, strongest e1RM first" },
    errors: [404],
  },
  {
    method: "get",
    path: "/api/summary",
    tag: "Stats",
    summary: "Training summary",
    description: "Defaults to the last 7 days. Muscle sets count primary muscles as 1 and secondary as 0.5 (`weighted_sets`).",
    query: SummaryInput,
    ok: { status: 200, description: "Sessions, volume, per-muscle and per-exercise totals" },
    errors: [400],
  },
  {
    method: "get",
    path: "/api/recent",
    tag: "Stats",
    summary: "Recent workouts",
    description: "The last N days including upcoming planned days, one compact line per exercise. What Claude reads before planning.",
    query: RecentInput,
    ok: { status: 200, description: "Recent workouts" },
    errors: [400],
  },
];
