/**
 * User-facing strings, kept in one place so they read as one voice and can be linted with the
 * taste skill's copy-lint (scripts/ui-copy.mjs exports them as text). Plain, specific, sentence case;
 * buttons are a verb and an object.
 */
export const COPY = {
  signIn: {
    title: "Your training, set by Claude.",
    lead: "Claude sets the cycle and the weights. You lift, tick each set, and it reviews the numbers.",
    google: "Continue with Google",
    dev: "Use dev sign-in",
    off: "Sign-in isn't set up on this server yet. The README's web app section explains how.",
  },
  tabs: { workout: "Workout", history: "History", body: "Body" },
  workout: {
    upNext: "Up next",
    start: (name: string) => `Start ${name}`,
    resume: (name: string) => `Resume ${name}`,
    notes: "Routine notes",
    cycleDone: (n: number) => `Cycle ${n} is done. Ask Claude to review it and set cycle ${n + 1}.`,
    startNext: (n: number) => `Start cycle ${n + 1}`,
    noProgram: "No program yet",
    noProgramHint: "Ask Claude in your gym chat: “make a program from my PaulStrong routines”.",
    inProgress: "Workout in progress",
  },
  log: {
    finish: "Finish workout",
    addSet: "Add set",
    addExercise: "Add exercise",
    last: "Last",
    skippedNote: "Planned sets you leave unticked are saved as skipped.",
    restOver: "Rest over",
    next: "Next",
    allDone: "Every planned set is done",
    skip: "Skip rest",
    setType: "Set type",
    types: { normal: "Working set", warmup: "Warm-up", failure: "To failure", dropset: "Drop set" },
    enter: (what: string) => `Enter ${what} first`,
    saved: "Saved",
    queued: "Saved on this phone. It syncs when you're back online.",
  },
  summary: { title: "Workout saved", prs: "New personal records", done: "Back to today" },
  history: { title: "History", empty: "No workouts logged yet.", more: "Load older workouts", thisWeek: "This week", lastWeek: "Last week" },
  exercise: { trend: "Progress", howTo: "How to do it", sessions: "Sessions", none: "Not logged yet." },
  body: { title: "Bodyweight", save: "Save weight", saved: (kg: number) => `Saved ${kg} kg`, signedIn: "Signed in as", signOut: "Sign out" },
  offline: (n: number) => (n > 0 ? `Offline · ${n} change${n === 1 ? "" : "s"} waiting to sync` : "Offline · changes sync when you're back"),
  syncing: (n: number) => `Syncing ${n} change${n === 1 ? "" : "s"}`,
  update: "A new version is ready",
  reload: "Reload",
} as const;
