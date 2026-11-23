import { useEffect, useState } from "preact/hooks";
import { ACTIVE_KEY } from "../app.tsx";
import { api, ApiError } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { COPY } from "../copy.ts";
import { dayLabel } from "../format.ts";
import { describeTarget } from "../lib/prefill.ts";
import { supersetLetter } from "../lib/rounds.ts";
import { navigate } from "../router.tsx";
import type { ProgramDetail, WorkoutDetail } from "../types.ts";

type Slot = ProgramDetail["current_cycle"]["slots"][number];
type RoutineInfo = { notes: string | null; exercises: { exercise: { id: string }; superset_group: number | null; rest_seconds: number | null }[] };

/** Short name for a routine: "PaulStrong 1 – Day 1 (Squat / Bench)" reads as "Day 1 (Squat / Bench)" on the cards. */
export const shortName = (name: string) => name.replace(/^.*?[–-]\s+(?=Day\s)/, "");

/** Rough session length: every set takes ~40s of work plus its rest. */
function estimateMinutes(slot: Slot, routine: RoutineInfo | null): number {
  let s = 0;
  slot.exercises.forEach((e, i) => {
    const rest = routine?.exercises[i]?.rest_seconds ?? 90;
    s += e.sets.length * (40 + rest);
  });
  return Math.max(5, Math.round(s / 60 / 5) * 5);
}

export function WorkoutTab() {
  const [program, setProgram] = useState<ProgramDetail | null | "none">(null);
  const [routine, setRoutine] = useState<RoutineInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    api<ProgramDetail>("GET", "/api/programs/current")
      .then((p) => {
        setProgram(p);
        const next = p.current_cycle.slots.find((s) => s.position === p.current_cycle.next_slot_position);
        if (next) void api<RoutineInfo>("GET", `/api/routines/${next.routine.id}`).then(setRoutine).catch(() => null);
      })
      .catch((e) => (e instanceof ApiError && e.status === 404 ? setProgram("none") : setError(String(e.message))));
  }, []);

  if (error) return <p class="error page">{error}</p>;
  if (program === null) return <div class="page" aria-busy="true" />;
  if (program === "none") {
    return (
      <section class="page enter">
        <h1>{COPY.tabs.workout}</h1>
        <div class="card m-nolift empty">
          <h2>{COPY.workout.noProgram}</h2>
          <p class="lead">{COPY.workout.noProgramHint}</p>
        </div>
      </section>
    );
  }

  const cycle = program.current_cycle;
  const next = cycle.slots.find((s) => s.position === cycle.next_slot_position) ?? null;
  const done = cycle.slots.filter((s) => s.status === "done").length;

  const start = async () => {
    setStarting(true);
    try {
      const r = await api<{ workout: WorkoutDetail }>("POST", "/api/programs/next-workout", {});
      if (!r.workout.start_time) await api("PATCH", `/api/workouts/${r.workout.id}`, { start_time: new Date().toISOString() });
      localStorage.setItem(ACTIVE_KEY, String(r.workout.id));
      navigate(`/w/${r.workout.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  };
  const resume = (id: number) => {
    localStorage.setItem(ACTIVE_KEY, String(id));
    navigate(`/w/${id}`);
  };

  return (
    <section class="page enter">
      <div class="page-head">
        <span class="label">
          {program.name} · Cycle {cycle.number}
        </span>
        <h1>{cycle.complete ? `Cycle ${cycle.number} done` : COPY.workout.upNext}</h1>
      </div>

      <div class="strip" aria-label={`Cycle ${cycle.number}: ${done} of ${cycle.slots.length} done`}>
        {cycle.slots.map((s) => (
          <div class={`step ${s.status === "done" ? "is-done" : s.position === cycle.next_slot_position ? "is-next" : s.status === "skipped" ? "is-skipped" : ""}`}>
            <div class="step__bar" />
            <span>{s.status === "done" && s.workout ? dayLabel(s.workout.date) : `Day ${s.position}`}</span>
          </div>
        ))}
      </div>

      {cycle.notes && <p class="note">Claude: {cycle.notes}</p>}

      {cycle.complete ? (
        <div class="upnext">
          <p>{COPY.workout.cycleDone(cycle.number)}</p>
          <button class="btn btn--primary btn--lg btn--block" disabled={starting} onClick={start}>
            {COPY.workout.startNext(cycle.number)}
          </button>
        </div>
      ) : (
        next && (
          <article class="upnext">
            <div class="page-head">
              <h2>{shortName(next.routine.name)}</h2>
              <span class="muted small">
                {next.exercises.length} exercises · about {estimateMinutes(next, routine)} min
              </span>
            </div>
            <ul class="upnext__lifts">
              {next.exercises.map((e, i) => {
                const working = e.sets.filter((x) => x.type !== "warmup");
                const ss = routine?.exercises[i]?.superset_group;
                const tag = ss != null ? `${supersetLetter(ss)}${routine!.exercises.slice(0, i).filter((x) => x.superset_group === ss).length + 1}` : "";
                return (
                  <li>
                    <span class="tag">{tag}</span>
                    <span class="lift">{e.exercise.name}</span>
                    <span class="num muted small">
                      {working.length} × {describeTarget(working[0] ?? null) || "—"}
                    </span>
                  </li>
                );
              })}
            </ul>
            {routine?.notes && (
              <details>
                <summary>
                  <Icon name="notebook" size={18} />
                  &nbsp;{COPY.workout.notes}
                </summary>
                <p class="note">{routine.notes}</p>
              </details>
            )}
            <button
              class="btn btn--primary btn--lg btn--block"
              disabled={starting}
              onClick={next.status === "started" && next.workout ? () => resume(next.workout!.id) : start}
            >
              <Icon name="play" size={18} />
              {next.status === "started" ? COPY.workout.resume(shortName(next.routine.name)) : COPY.workout.start(shortName(next.routine.name))}
            </button>
          </article>
        )
      )}

      <section class="card m-nolift" aria-label="This cycle">
        <ul class="row-list">
          {cycle.slots.map((s) => {
            const linked = s.status === "done" && s.workout;
            const body = (
              <>
                <span class={`chip ${s.status === "done" ? "chip--accent" : "chip--quiet"}`}>
                  {s.status === "done" ? <Icon name="check" size={14} /> : null}
                  {s.status === "done" ? "Done" : s.status === "skipped" ? "Skipped" : s.position === cycle.next_slot_position ? "Next" : `Day ${s.position}`}
                </span>
                <span class="grow">
                  <span>{shortName(s.routine.name)}</span>
                  <span class="muted small">{s.exercises.map((e) => e.exercise.name).join(", ")}</span>
                </span>
                {linked && <Icon name="chevronRight" size={18} />}
              </>
            );
            return (
              <li>
                {linked ? (
                  <a
                    class="routine-row"
                    href={`/history/${s.workout!.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(`/history/${s.workout!.id}`);
                    }}
                  >
                    {body}
                  </a>
                ) : (
                  <div class="routine-row">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </section>
  );
}
