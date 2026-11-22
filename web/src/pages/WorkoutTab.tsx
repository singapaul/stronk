import { useEffect, useState } from "preact/hooks";
import { api, ApiError } from "../api.ts";
import { dayLabel } from "../format.ts";
import { describeTarget } from "../lib/prefill.ts";
import { navigate } from "../router.tsx";
import type { ProgramDetail, WorkoutDetail } from "../types.ts";

const STATUS_LABEL = { pending: "", started: "In progress", done: "Done", skipped: "Skipped" } as const;

export function WorkoutTab() {
  const [program, setProgram] = useState<ProgramDetail | null | "none">(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    api<ProgramDetail>("GET", "/api/programs/current")
      .then(setProgram)
      .catch((e) => (e instanceof ApiError && e.status === 404 ? setProgram("none") : setError(String(e.message))));
  }, []);

  if (error) return <p class="error">{error}</p>;
  if (program === null) return <p class="muted pad">Loading…</p>;
  if (program === "none") {
    return (
      <section class="pad">
        <h1>Workout</h1>
        <div class="card empty">
          <p>No active program yet.</p>
          <p class="muted small">Ask Claude to create one, e.g. “make a push/pull/legs program from my routines”.</p>
        </div>
      </section>
    );
  }

  const cycle = program.current_cycle;
  const next = cycle.slots.find((s) => s.position === cycle.next_slot_position);
  const done = cycle.slots.filter((s) => s.status === "done").length;

  const start = async () => {
    setStarting(true);
    try {
      const r = await api<{ workout: WorkoutDetail; already_started: boolean }>("POST", "/api/programs/next-workout", {});
      if (!r.workout.start_time) {
        await api("PATCH", `/api/workouts/${r.workout.id}`, { start_time: new Date().toISOString() });
      }
      navigate(`/w/${r.workout.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };

  return (
    <section class="pad">
      <h1>Workout</h1>
      <div class="cycle-head">
        <div>
          <div class="title">{program.name}</div>
          <div class="muted small">
            Cycle {cycle.number} · {done}/{cycle.slots.length} done
            {cycle.targets_source === "claude" ? " · targets set by Claude" : cycle.targets_source === "carried_over" ? " · targets carried over" : ""}
          </div>
        </div>
      </div>
      {cycle.notes && <p class="note">{cycle.notes}</p>}

      {cycle.complete ? (
        <div class="card highlight">
          <p>
            <strong>Cycle {cycle.number} complete.</strong>
          </p>
          <p class="muted small">Claude can review it and set cycle {cycle.number + 1}'s targets. Starting now carries the current targets over.</p>
          <button class="btn primary big" disabled={starting} onClick={start}>
            Start cycle {cycle.number + 1}
          </button>
        </div>
      ) : (
        next && (
          <button class="btn primary big" disabled={starting} onClick={next.status === "started" && next.workout ? () => navigate(`/w/${next.workout!.id}`) : start}>
            {next.status === "started" ? `Resume ${next.routine.name}` : `Start ${next.routine.name}`}
          </button>
        )
      )}

      <div class="routines">
        {cycle.slots.map((s) => (
          <article class={`card routine ${s.position === cycle.next_slot_position ? "next" : ""} ${s.status}`}>
            <header>
              <span class="routine-name">{s.routine.name}</span>
              <span class={`badge ${s.status}`}>
                {s.position === cycle.next_slot_position && s.status === "pending" ? "Up next" : STATUS_LABEL[s.status]}
                {s.status === "done" && s.workout ? ` · ${dayLabel(s.workout.date)}` : ""}
              </span>
            </header>
            <ul class="routine-lifts">
              {s.exercises.map((e) => {
                const working = e.sets.filter((x) => x.type !== "warmup");
                return (
                  <li>
                    <span>{e.exercise.name}</span>
                    <span class="muted">
                      {working.length} × {describeTarget(working[0] ?? null) || "—"}
                    </span>
                  </li>
                );
              })}
            </ul>
            {s.status === "done" && s.workout && (
              <button class="link" onClick={() => navigate(`/history/${s.workout!.id}`)}>
                View workout
              </button>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
