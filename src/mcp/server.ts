import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z, ZodError } from "zod";
import type { Ctx } from "../app.ts";
import { AppError } from "../errors.ts";
import {
  BodyweightFields,
  CompletePlannedSetShape,
  CustomExerciseInput,
  ExerciseType,
  IsoDate,
  LEVELS,
  LogSetShape,
  LogWorkoutShape,
  PlanSessionShape,
  ProgramPatchShape,
  ProgramShape,
  SetCycleTargetsShape,
  RoutinePatchShape,
  RoutineShape,
  SetPatchFields,
} from "../schemas.ts";
import { getBodyweight, logBodyweight } from "../services/body.ts";
import { createCustomExercise, getExercise, searchExercises } from "../services/exercises.ts";
import { createRoutine, getRoutine, listRoutines, startRoutine, updateRoutine } from "../services/routines.ts";
import {
  createProgram,
  describeTargets,
  getProgram,
  reviewCycle,
  setCycleTargets,
  skipSlot,
  startNextWorkout,
  updateProgram,
  type CycleDetail,
  type CycleReview,
  type ProgramDetail,
} from "../services/programs.ts";
import { exerciseHistory, formatSet, personalRecords, recentWorkouts } from "../services/stats.ts";
import {
  completePlannedSet,
  deleteSet,
  getWorkout,
  getWorkoutByDate,
  logSet,
  logWorkout,
  planSession,
  today,
  updateSet,
  type SetResult,
  type WorkoutDetail,
} from "../services/workouts.ts";

export const SERVER_INSTRUCTIONS = `Personal gym log. Conventions:
- All weights are kilograms (weight_kg). Never send pounds; convert first if the user speaks in lb.
- Exercise ids are exact strings. Always call search_exercises first and use an id from its results; lifts the user has logged before rank first. If a tool says an exercise wasn't found, pick from the suggestions it returns.
- Set type: warmup | normal (default) | failure | dropset. Bodyweight exercises (type bodyweight_*) take weight_kg as added load; negative means assistance. Timed exercises use duration_s, cardio uses distance_m/duration_s.
- log_set with no workout_id/date goes to today's workout (Europe/London; the day rolls over at 04:00), creating it if needed. If today has planned sets for that exercise, log_set fills the next one automatically, so don't call plan tools to log.
- One workout per day. Planning or logging onto a day that already has a workout merges into it.
- Planning: call get_recent_workouts and get_history for the main lifts first, then apply progressive overload from the real numbers (e.g. add reps within the rep range, then add load once the top of the range is hit at the target RPE). If a saved routine fits, prefer start_routine over writing a plan from scratch.
- Programs: a program is an ordered list of routines run on repeat; one pass through the list is a cycle, and each cycle keeps its own target sets. While a program is active, start sessions with start_next_workout (not start_routine), then log sets as usual.
- Progressing a program: call review_cycle, apply progressive overload to the actual numbers per lift (add reps within the range; add load once the top of the range is hit on every set at or under the target RPE; hold or reduce when sets were missed), propose the new targets in chat, and once the user agrees save them with set_cycle_targets. Only list the lifts you change; the rest carry over.
- Mistakes: fix with update_set or delete_set (get_workout shows set ids).`;

type Data = Record<string, unknown>;

/**
 * structuredContent always carries the full data. The text block (what most chat clients show the
 * model) carries the summary plus JSON: the full data, or a compact projection for tools whose full
 * output would be large (`text`), so a chat isn't charged thousands of tokens for one call.
 */
const ok = (summary: string, data: Data, text?: Data): CallToolResult => ({
  content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(text ?? data)}` }],
  structuredContent: data,
});

/** Run a service call, turning domain/validation errors into tool errors Claude can act on. */
function run(fn: () => { summary: string; data: Data; text?: Data }): CallToolResult {
  try {
    const { summary, data, text } = fn();
    return ok(summary, data, text);
  } catch (err) {
    if (err instanceof AppError) {
      const payload = { error: err.message, ...(err.details !== undefined ? { details: err.details } : {}) };
      return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
    }
    if (err instanceof ZodError) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "Invalid input", details: err.issues }) }] };
    }
    throw err;
  }
}

// ---------- Summaries ----------

function describeSetResult(verb: string, r: SetResult): string {
  const text = formatSet({ ...r.set, exercise_type: r.exercise.type });
  const parts = [`${verb} ${r.exercise.name} set ${r.set.set_number}: ${text} (${r.date}, workout ${r.workout_id}).`];
  const prs = Object.entries(r.pr).filter(([, v]) => v).map(([k]) => k.replace(/_/g, " "));
  if (prs.length) parts.push(`New PR: ${prs.join(", ")}.`);
  if (r.next_planned) {
    const t = r.next_planned.target;
    const reps = t ? (t.reps_min === t.reps_max ? `${t.reps_min ?? "?"}` : `${t.reps_min ?? "?"}-${t.reps_max ?? "?"}`) : "?";
    parts.push(`${r.planned_remaining} planned left; next: set ${r.next_planned.set_number} ${t?.weight_kg ?? "?"}kg × ${reps}.`);
  }
  if (r.warnings.length) parts.push(`Note: ${r.warnings.join("; ")}.`);
  return parts.join(" ");
}

function describeWorkout(w: WorkoutDetail): string {
  const head = `${w.name ?? "Workout"} on ${w.date} (id ${w.id}, ${w.status}): ${w.totals.performed_sets} performed, ${w.totals.planned_sets} planned`;
  const lines = w.exercises.map(
    (e) =>
      `- ${e.exercise.name}: ` +
      e.sets
        .map((s) =>
          s.is_planned
            ? `[plan #${s.id} ${s.target?.weight_kg ?? "?"}×${s.target?.reps_min === s.target?.reps_max ? (s.target?.reps_min ?? "?") : `${s.target?.reps_min ?? "?"}-${s.target?.reps_max ?? "?"}`}]`
            : formatSet({ ...s, exercise_type: e.exercise.type }),
        )
        .join(", "),
  );
  return [head, ...lines].join("\n");
}

/** Cycle without per-set objects: targets as one string per lift ("80×5-8, 80×5-8"). */
function compactCycle(c: CycleDetail) {
  return {
    number: c.number,
    targets_source: c.targets_source,
    notes: c.notes,
    complete: c.complete,
    next_slot_position: c.next_slot_position,
    slots: c.slots.map((s) => ({
      position: s.position,
      routine: s.routine.name,
      status: s.status,
      workout: s.workout,
      exercises: s.exercises.map((e) => ({ exercise_id: e.exercise.id, sets: e.sets.length, targets: describeTargets(e.sets) })),
    })),
  };
}

function compactProgram(p: ProgramDetail) {
  return {
    id: p.id,
    name: p.name,
    is_active: p.is_active,
    routines: p.slots.map((s) => s.routine.name),
    cycles_completed: p.cycles_completed,
    current_cycle: compactCycle(p.current_cycle),
  };
}

/**
 * Review without raw set lists or repeated prose: the summary above the JSON already has each
 * lift's one-line target → performed line, so the JSON keeps only the numbers progression needs.
 */
function compactReview(r: CycleReview) {
  return {
    program: r.program,
    cycle: r.cycle,
    window: r.window,
    slots: r.slots.map((s) => ({
      position: s.position,
      routine: s.routine,
      status: s.status,
      date: s.date,
      exercises: s.exercises.map((e) => ({
        exercise_id: e.exercise.id,
        working_target_sets: e.working_target_sets,
        sets_hit: e.sets_hit,
        top_of_range_all_sets: e.top_of_range_all_sets,
        avg_rpe: e.avg_rpe,
        target_rpe: e.target_rpe,
        best_e1rm_kg: e.best_e1rm_kg,
        prev_cycle_best_e1rm_kg: e.prev_cycle_best_e1rm_kg,
      })),
    })),
    bodyweight_change_kg: r.bodyweight.change_kg,
    adhoc_workouts: r.adhoc_workouts.length,
    next_cycle: r.next_cycle,
  };
}

function describeCycle(c: CycleDetail): string {
  const slots = c.slots.map((s) => `${s.routine.name}: ${s.status}${s.workout ? ` (${s.workout.date})` : ""}`).join(", ");
  return `Cycle ${c.number}${c.complete ? " complete" : ""} [targets: ${c.targets_source}] — ${slots}`;
}

function describeCycleTargets(c: CycleDetail): string {
  return c.slots
    .map((s) => `${s.position}. ${s.routine.name} (${s.status})\n` + s.exercises.map((e) => `   - ${e.exercise.name}: ${describeTargets(e.sets)}`).join("\n"))
    .join("\n");
}

function describeProgram(p: ProgramDetail): string {
  return `${p.name} (id ${p.id}${p.is_active ? ", active" : ""}): ${p.slots.map((s) => s.routine.name).join(" → ")}. ${p.cycles_completed} cycle(s) completed.\n${describeCycle(p.current_cycle)}\n${describeCycleTargets(p.current_cycle)}`;
}

const routineId = z.number().int().positive().describe("Routine id from list_routines");

/** Build a fresh server per request (stateless transport). Every tool calls the same services as REST. */
export function buildMcpServer(ctx: Ctx): McpServer {
  const server = new McpServer({ name: "stronk-gym", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });
  const { db } = ctx;
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

  // ----- Exercises -----

  server.registerTool(
    "search_exercises",
    {
      title: "Search exercises",
      description:
        "Find exercises by name words, muscle, equipment, level, category or type. Returns ids to use with every other tool. Lifts already logged rank first (times_logged).",
      inputSchema: {
        query: z.string().optional().describe("Name words, e.g. 'incline dumbbell press'"),
        muscle: z.string().optional().describe("Primary muscle: chest, shoulders, triceps, biceps, lats, 'middle back', 'lower back', traps, quadriceps, hamstrings, glutes, calves, abdominals, forearms, adductors, abductors, neck"),
        equipment: z.string().optional().describe("barbell, dumbbell, cable, machine, kettlebells, bands, 'body only', 'e-z curl bar', ..."),
        level: z.enum(LEVELS).optional(),
        category: z.string().optional().describe("strength, powerlifting, olympic weightlifting, strongman, plyometrics, stretching, cardio"),
        type: ExerciseType.optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: readOnly,
    },
    (args) =>
      run(() => {
        const res = searchExercises(db, { ...args, offset: 0 });
        const lines = res.results.map((r) => `${r.id} (${r.name}${r.times_logged ? `, logged ${r.times_logged}×` : ""})`);
        return { summary: `${res.total} match(es); showing ${res.results.length}:\n${lines.join("\n")}`, data: res };
      }),
  );

  server.registerTool(
    "get_exercise",
    {
      title: "Get exercise",
      description: "Full details for one exercise: type, muscles, equipment, instructions and image URLs.",
      inputSchema: { exercise_id: z.string().describe("Exact id from search_exercises") },
      annotations: readOnly,
    },
    ({ exercise_id }) =>
      run(() => {
        const ex = getExercise(db, exercise_id);
        return { summary: `${ex.name} (${ex.type}, ${ex.equipment ?? "no equipment"}; ${ex.primary_muscles.join(", ")})`, data: ex };
      }),
  );

  server.registerTool(
    "create_custom_exercise",
    {
      title: "Create custom exercise",
      description: "Add an exercise missing from the library. Search first to avoid duplicates. Id becomes custom_<slug>.",
      inputSchema: CustomExerciseInput.shape,
      annotations: write,
    },
    (args) =>
      run(() => {
        const ex = createCustomExercise(db, CustomExerciseInput.parse(args));
        return { summary: `Created ${ex.id} (${ex.type})`, data: ex };
      }),
  );

  // ----- Logging -----

  server.registerTool(
    "log_set",
    {
      title: "Log a set",
      description:
        "Log one performed set. With no workout_id/date it goes to today's workout (created if needed) and fills the next planned set for that exercise if there is one. Returns PR flags and the next planned target.",
      inputSchema: LogSetShape,
      annotations: write,
    },
    (args) => run(() => {
      const r = logSet(ctx, args);
      return { summary: describeSetResult("Logged", r), data: r };
    }),
  );

  server.registerTool(
    "log_workout",
    {
      title: "Log a whole workout",
      description:
        "Log a finished session in one call: blocks of sets per exercise. Merges into that day's workout if one exists. Pass start_time/end_time for backfills.",
      inputSchema: LogWorkoutShape,
      annotations: write,
    },
    (args) =>
      run(() => {
        const r = logWorkout(ctx, args);
        const prs = r.prs.length ? `\nPRs: ${r.prs.map((p) => p.exercise_id).join(", ")}` : "";
        return { summary: describeWorkout(r.workout) + prs, data: r };
      }),
  );

  server.registerTool(
    "complete_planned_set",
    {
      title: "Complete a planned set",
      description: "Record actual numbers for one specific planned set (ids from get_workout). Targets are kept for comparison.",
      inputSchema: CompletePlannedSetShape,
      annotations: write,
    },
    (args) =>
      run(() => {
        const r = completePlannedSet(ctx, args);
        return { summary: describeSetResult("Completed", r), data: r };
      }),
  );

  server.registerTool(
    "update_set",
    {
      title: "Update a set",
      description: "Correct a logged set (e.g. wrong weight). Only the fields given change; null clears a field.",
      inputSchema: { set_id: z.number().int().positive(), ...SetPatchFields },
      annotations: { ...write, idempotentHint: true },
    },
    ({ set_id, ...patch }) =>
      run(() => {
        const r = updateSet(ctx, set_id, patch);
        return { summary: describeSetResult("Updated", r), data: r };
      }),
  );

  server.registerTool(
    "delete_set",
    {
      title: "Delete a set",
      description: "Delete one set. Remaining sets for that exercise are renumbered.",
      inputSchema: { set_id: z.number().int().positive() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    ({ set_id }) =>
      run(() => {
        const r = deleteSet(ctx, set_id);
        return { summary: `Deleted set ${set_id} from workout ${r.workout_id}`, data: r };
      }),
  );

  // ----- Reading -----

  server.registerTool(
    "get_workout",
    {
      title: "Get a workout",
      description: "One day's workout with every set (and planned set ids). Defaults to today.",
      inputSchema: {
        workout_id: z.number().int().positive().optional(),
        date: IsoDate.optional().describe("YYYY-MM-DD; defaults to today"),
      },
      annotations: readOnly,
    },
    ({ workout_id, date }) =>
      run(() => {
        if (workout_id != null) {
          const w = getWorkout(ctx, workout_id);
          return { summary: describeWorkout(w), data: w };
        }
        const d = date ?? today(ctx);
        const w = getWorkoutByDate(ctx, d);
        if (!w) return { summary: `No workout on ${d}`, data: { date: d, workout: null } };
        return { summary: describeWorkout(w), data: w };
      }),
  );

  server.registerTool(
    "get_history",
    {
      title: "Exercise history",
      description: "Recent sessions for one exercise: sets, top set, volume and estimated 1RM. Use before planning.",
      inputSchema: {
        exercise_id: z.string(),
        limit: z.number().int().min(1).max(100).default(5).describe("Sessions (or sets with format=sets)"),
        from: IsoDate.optional(),
        to: IsoDate.optional(),
        format: z.enum(["sessions", "sets"]).default("sessions"),
      },
      annotations: readOnly,
    },
    ({ exercise_id, ...input }) =>
      run(() => {
        const h = exerciseHistory(ctx, exercise_id, input);
        const summary = h.sessions
          ? `${h.exercise.name}: ${h.total_sessions} session(s)\n` +
            h.sessions.map((s) => `- ${s.date}: ${s.summary}${s.e1rm_kg ? ` (e1RM ${s.e1rm_kg})` : ""}`).join("\n")
          : `${h.exercise.name}: ${h.sets?.length ?? 0} set(s)`;
        return { summary: summary || `${h.exercise.name}: no history yet`, data: h };
      }),
  );

  server.registerTool(
    "get_recent_workouts",
    {
      title: "Recent workouts",
      description: "What's been done (and planned) lately, one compact line per exercise. Start here when planning.",
      inputSchema: { days: z.number().int().min(1).max(90).default(14) },
      annotations: readOnly,
    },
    ({ days }) =>
      run(() => {
        const r = recentWorkouts(ctx, days);
        const lines = r.workouts.map(
          (w) =>
            `${w.date} ${w.name ?? ""} [${w.status}]\n` +
            w.exercises.map((e) => `  - ${e.name}: ${e.performed ?? ""}${e.planned ? ` planned ${e.planned}` : ""}`).join("\n"),
        );
        return { summary: lines.length ? lines.join("\n") : `No workouts in the last ${days} days`, data: r };
      }),
  );

  server.registerTool(
    "get_prs",
    {
      title: "Personal records",
      description: "Heaviest set, best estimated 1RM and best reps at each weight, per exercise (or one exercise).",
      inputSchema: { exercise_id: z.string().optional() },
      annotations: readOnly,
    },
    ({ exercise_id }) =>
      run(() => {
        const r = personalRecords(ctx, exercise_id);
        const lines = r.records.map((p) => {
          const h = p.heaviest as { load_kg: number; reps: number } | undefined;
          const e = p.best_e1rm as { e1rm_kg: number } | undefined;
          return `- ${p.exercise.name}: ${h ? `heaviest ${h.load_kg}×${h.reps}` : ""}${e ? `, e1RM ${e.e1rm_kg}` : ""}`;
        });
        return { summary: lines.length ? lines.join("\n") : "No records yet", data: r };
      }),
  );

  // ----- Planning -----

  server.registerTool(
    "plan_session",
    {
      title: "Plan a session",
      description:
        "Save target sets for a day (default today). Sets are planned until performed; log_set fills them in order. Merges into an existing workout that day.",
      inputSchema: PlanSessionShape,
      annotations: write,
    },
    (args) =>
      run(() => {
        const w = planSession(ctx, args);
        return { summary: describeWorkout(w), data: w };
      }),
  );

  server.registerTool(
    "list_routines",
    {
      title: "List routines",
      description: "Saved routines (templates like 'Push A') with their exercises and when each was last done.",
      inputSchema: {},
      annotations: readOnly,
    },
    () =>
      run(() => {
        const routines = listRoutines(ctx);
        const lines = routines.map((r) => `- ${r.id}: ${r.name} (${r.exercises.join(", ")}; last ${r.last_performed ?? "never"})`);
        return { summary: lines.length ? lines.join("\n") : "No routines saved", data: { routines } };
      }),
  );

  server.registerTool(
    "get_routine",
    {
      title: "Get routine",
      description: "A routine's blocks and target sets.",
      inputSchema: { routine_id: routineId },
      annotations: readOnly,
    },
    ({ routine_id }) =>
      run(() => {
        const r = getRoutine(ctx, routine_id);
        return { summary: `${r.name}: ${r.exercises.map((e) => `${e.exercise.name} ×${e.sets.length}`).join(", ")}`, data: r };
      }),
  );

  server.registerTool(
    "create_routine",
    {
      title: "Create routine",
      description: "Save a reusable routine. Each exercise appears once, with its target sets (reps or reps_min/reps_max).",
      inputSchema: RoutineShape,
      annotations: write,
    },
    (args) =>
      run(() => {
        const r = createRoutine(ctx, args);
        return { summary: `Created routine ${r.id}: ${r.name}`, data: r };
      }),
  );

  server.registerTool(
    "update_routine",
    {
      title: "Update routine",
      description: "Rename a routine or change notes. Passing exercises replaces all of its blocks.",
      inputSchema: { routine_id: routineId, ...RoutinePatchShape },
      annotations: { ...write, idempotentHint: true },
    },
    ({ routine_id, ...patch }) =>
      run(() => {
        const r = updateRoutine(ctx, routine_id, patch);
        return { summary: `Updated routine ${r.id}: ${r.name}`, data: r };
      }),
  );

  server.registerTool(
    "start_routine",
    {
      title: "Start routine",
      description: "Copy a routine into a day's workout (default today) as planned sets, ready for log_set.",
      inputSchema: { routine_id: routineId, date: IsoDate.optional() },
      annotations: write,
    },
    ({ routine_id, date }) =>
      run(() => {
        const w = startRoutine(ctx, routine_id, date);
        return { summary: describeWorkout(w), data: w };
      }),
  );

  // ----- Programs & cycles -----

  server.registerTool(
    "create_program",
    {
      title: "Create program",
      description:
        "Create a program: routines (ids from list_routines) run in order on repeat. One pass is a cycle; cycle 1 starts with the routines' targets. Becomes the active program by default.",
      inputSchema: ProgramShape,
      annotations: write,
    },
    (args) =>
      run(() => {
        const p = createProgram(ctx, { ...args, activate: args.activate ?? true });
        return { summary: describeProgram(p), data: p, text: compactProgram(p) };
      }),
  );

  server.registerTool(
    "update_program",
    {
      title: "Update program",
      description: "Rename, change notes, or switch the active program. Changing routine_ids is only allowed before any of its workouts has started.",
      inputSchema: { program_id: z.number().int().positive(), ...ProgramPatchShape },
      annotations: { ...write, idempotentHint: true },
    },
    ({ program_id, ...patch }) =>
      run(() => {
        const p = updateProgram(ctx, program_id, patch);
        return { summary: describeProgram(p), data: p, text: compactProgram(p) };
      }),
  );

  server.registerTool(
    "get_program",
    {
      title: "Get program",
      description: "The active program (or one by id): its routines and the current cycle with each slot's status and target sets.",
      inputSchema: { program_id: z.number().int().positive().optional() },
      annotations: readOnly,
    },
    ({ program_id }) =>
      run(() => {
        const p = getProgram(ctx, program_id);
        return { summary: describeProgram(p), data: p, text: compactProgram(p) };
      }),
  );

  server.registerTool(
    "start_next_workout",
    {
      title: "Start next workout",
      description:
        "Plan the next workout of the active program onto a day (default today) with the current cycle's targets, then log sets with log_set. Starts the next cycle (targets carried over) when the current one is complete.",
      inputSchema: { date: IsoDate.optional() },
      annotations: write,
    },
    ({ date }) =>
      run(() => {
        const r = startNextWorkout(ctx, { date });
        const head = `Cycle ${r.cycle.number} · ${r.slot.routine.name} (${r.slot.position}/${r.slot.of})${r.already_started ? " — already planned" : ""}`;
        return { summary: `${head}\n${describeWorkout(r.workout)}`, data: r };
      }),
  );

  server.registerTool(
    "skip_workout_slot",
    {
      title: "Skip a program workout",
      description: "Skip a workout of the current cycle (default: the next one due) so the cycle can complete without it.",
      inputSchema: { slot_position: z.number().int().min(1).optional() },
      annotations: write,
    },
    ({ slot_position }) =>
      run(() => {
        const r = skipSlot(ctx, { slot_position });
        return { summary: `Skipped ${r.skipped.routine} (slot ${r.skipped.position}). ${describeCycle(r.cycle)}`, data: r };
      }),
  );

  server.registerTool(
    "review_cycle",
    {
      title: "Review cycle",
      description:
        "How a cycle went (default: the latest completed): per lift, targets vs performed sets, sets hit, top of rep range, RPE vs target, and e1RM vs the previous cycle. Use it before set_cycle_targets.",
      inputSchema: { cycle_number: z.number().int().min(1).optional() },
      annotations: readOnly,
    },
    ({ cycle_number }) =>
      run(() => {
        const r = reviewCycle(ctx, { cycle_number });
        const lines = r.slots.flatMap((s) =>
          s.status === "done" ? s.exercises.map((e) => `- ${e.summary}`) : [`- ${s.routine}: ${s.status}`],
        );
        const bw = r.bodyweight.change_kg != null ? `\nBodyweight change: ${r.bodyweight.change_kg} kg` : "";
        return {
          summary: `${r.program.name} cycle ${r.cycle.number} (${r.window.from ?? "?"} → ${r.window.to ?? "?"})${r.cycle.complete ? "" : " [not complete]"}\n${lines.join("\n")}${bw}`,
          data: r,
          text: compactReview(r),
        };
      }),
  );

  server.registerTool(
    "set_cycle_targets",
    {
      title: "Set cycle targets",
      description:
        "Save target sets for a cycle (default: the next cycle, or the current one if it's unfinished). Only listed lifts change; each listed lift's sets are replaced. Workouts already started are locked. Confirm the changes with the user first.",
      inputSchema: SetCycleTargetsShape,
      annotations: { ...write, idempotentHint: true },
    },
    (args) =>
      run(() => {
        const r = setCycleTargets(ctx, args);
        return {
          summary: `Saved targets for ${r.program.name} cycle ${r.cycle.number}.\n${describeCycleTargets(r.cycle)}`,
          data: r,
          text: { program: r.program, cycle: compactCycle(r.cycle) },
        };
      }),
  );

  // ----- Bodyweight -----

  server.registerTool(
    "log_bodyweight",
    {
      title: "Log bodyweight",
      description: "Record bodyweight for a day (default today). Used to load bodyweight exercises like pull-ups.",
      inputSchema: { date: IsoDate.optional(), ...BodyweightFields },
      annotations: { ...write, idempotentHint: true },
    },
    (args) =>
      run(() => {
        const e = logBodyweight(ctx, args);
        return { summary: `Bodyweight ${e.weight_kg}kg on ${e.date}`, data: e };
      }),
  );

  server.registerTool(
    "get_bodyweight",
    {
      title: "Bodyweight history",
      description: "Bodyweight entries, newest first, with change over the range.",
      inputSchema: { from: IsoDate.optional(), to: IsoDate.optional(), limit: z.number().int().min(1).max(365).default(30) },
      annotations: readOnly,
    },
    (args) =>
      run(() => {
        const r = getBodyweight(ctx, args);
        return {
          summary: r.latest ? `Latest ${r.latest.weight_kg}kg (${r.latest.date})${r.change_kg != null ? `, change ${r.change_kg}kg` : ""}` : "No bodyweight logged",
          data: r,
        };
      }),
  );

  return server;
}
