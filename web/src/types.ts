/** Response shapes the app uses (a subset of the API; see /docs for the full spec). */

export type Target = {
  reps_min: number | null;
  reps_max: number | null;
  weight_kg: number | null;
  rpe: number | null;
  duration_s: number | null;
  distance_m: number | null;
};

export type SetOut = {
  id: number;
  set_number: number;
  type: string;
  is_planned: boolean;
  skipped?: boolean;
  reps: number | null;
  weight_kg: number | null;
  duration_s: number | null;
  distance_m: number | null;
  rpe: number | null;
  notes: string | null;
  target: Target | null;
  performed_at: string | null;
};

export type WorkoutDetail = {
  id: number;
  date: string;
  name: string | null;
  notes: string | null;
  routine_id: number | null;
  cycle_id: number | null;
  slot_id: number | null;
  status: "planned" | "in_progress" | "completed";
  start_time: string | null;
  end_time: string | null;
  duration_min: number | null;
  totals: { performed_sets: number; planned_sets: number; volume_kg: number };
  exercises: {
    block_id: number;
    position: number;
    exercise: { id: string; name: string; type: string };
    superset_group: number | null;
    notes: string | null;
    rest_seconds: number | null;
    sets: SetOut[];
  }[];
};

export type PrFlags = { heaviest: boolean; e1rm: boolean; reps_at_weight: boolean };

export type SetResult = {
  set: SetOut;
  workout_id: number;
  date: string;
  exercise: { id: string; name: string; type: string };
  pr: PrFlags;
  is_pr: boolean;
  warnings: string[];
};

export type SlotStatus = "pending" | "started" | "done" | "skipped";

export type ProgramDetail = {
  id: number;
  name: string;
  notes: string | null;
  cycles_completed: number;
  current_cycle: {
    number: number;
    targets_source: string;
    notes: string | null;
    complete: boolean;
    next_slot_position: number | null;
    slots: {
      position: number;
      routine: { id: number; name: string };
      status: SlotStatus;
      workout: { id: number; date: string } | null;
      exercises: { exercise: { id: string; name: string; type: string }; sets: (Target & { set_number: number; type: string })[] }[];
    }[];
  };
};

export type WorkoutSummary = {
  id: number;
  date: string;
  name: string | null;
  status: string;
  performed_sets: number;
  planned_sets: number;
  volume_kg: number;
  duration_min: number | null;
  cycle_number: number | null;
  exercises: string[];
};

export type HistorySession = {
  date: string;
  workout_id: number;
  summary: string;
  top_set: { load_kg: number | null; reps: number | null; text: string } | null;
  e1rm_kg: number | null;
  volume_kg: number;
  sets: { set_number: number; type: string; reps: number | null; weight_kg: number | null; duration_s: number | null; text: string }[];
};

export type ExerciseSummary = { id: string; name: string; equipment: string | null; primary_muscles: string[]; times_logged: number };

export type BodyweightEntry = {
  date: string;
  weight_kg: number | null;
  fat_percent: number | null;
  notes: string | null;
  /** health_connect: synced from the phone; a manual entry for the same day replaces it. */
  source?: "manual" | "health_connect";
};
