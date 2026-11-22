import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, ApiError, flushOutbox, outbox, writeOrQueue } from "../api.ts";
import { ExercisePicker } from "../components/ExercisePicker.tsx";
import { RestBar } from "../components/RestBar.tsx";
import { dayBefore, minutes, SET_TYPE_LABEL, volume } from "../format.ts";
import { describeTarget, lastFor } from "../lib/prefill.ts";
import { formatClock, startRest, type RestTimer } from "../lib/timer.ts";
import { Link, navigate } from "../router.tsx";
import type { ExerciseSummary, HistorySession, SetResult, Target, WorkoutDetail } from "../types.ts";

/** Which two inputs a row has, by exercise type. */
type FieldKey = "weight_kg" | "reps" | "duration_s" | "distance_m";
const FIELDS: Record<string, [FieldKey | null, FieldKey]> = {
  weight_reps: ["weight_kg", "reps"],
  reps_only: [null, "reps"],
  bodyweight_reps: ["weight_kg", "reps"],
  bodyweight_assisted_reps: ["weight_kg", "reps"],
  duration: [null, "duration_s"],
  weight_duration: ["weight_kg", "duration_s"],
  distance_duration: ["distance_m", "duration_s"],
  short_distance_weight: ["weight_kg", "distance_m"],
};
const HEADER: Record<FieldKey, string> = { weight_kg: "kg", reps: "reps", duration_s: "sec", distance_m: "m" };
const fieldsFor = (type: string) => FIELDS[type] ?? FIELDS.weight_reps!;

function targetValue(t: Target | null, f: FieldKey | null): string {
  if (!t || !f) return "";
  const v = f === "reps" ? (t.reps_max ?? t.reps_min) : f === "weight_kg" ? t.weight_kg : f === "duration_s" ? t.duration_s : t.distance_m;
  return v == null ? "" : String(v);
}

type Row = {
  key: string;
  serverId: number | null;
  setNumber: number;
  type: string;
  target: Target | null;
  a: string;
  b: string;
  done: boolean;
  pending: boolean;
  pr: boolean;
};

type Block = {
  exerciseId: string;
  name: string;
  exType: string;
  rest: number | null;
  notes: string | null;
  superset: number | null;
  rows: Row[];
  last: HistorySession["sets"];
};

const REST_KEY = "stronk.rest";
const readRest = (): RestTimer | null => {
  try {
    return JSON.parse(localStorage.getItem(REST_KEY) ?? "null");
  } catch {
    return null;
  }
};

function toBlocks(w: WorkoutDetail): Block[] {
  return w.exercises.map((e) => {
    const [fa, fb] = fieldsFor(e.exercise.type);
    return {
      exerciseId: e.exercise.id,
      name: e.exercise.name,
      exType: e.exercise.type,
      rest: e.rest_seconds,
      notes: e.notes,
      superset: e.superset_group,
      last: [],
      rows: e.sets.map((s) => ({
        key: String(s.id),
        serverId: s.id,
        setNumber: s.set_number,
        type: s.type,
        target: s.target,
        a: s.is_planned ? targetValue(s.target, fa) : fa ? String(s[fa] ?? "") : "",
        b: s.is_planned ? targetValue(s.target, fb) : String(s[fb] ?? ""),
        done: !s.is_planned,
        pending: outbox.pendingFor(String(s.id)),
        pr: false,
      })),
    };
  });
}

export function ActiveWorkout({ id }: { id: number }) {
  const [workout, setWorkout] = useState<WorkoutDetail | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rest, setRest] = useState<RestTimer | null>(readRest);
  const [now, setNow] = useState(Date.now());
  const [picker, setPicker] = useState(false);
  const [typeMenu, setTypeMenu] = useState<string | null>(null);
  const [summary, setSummary] = useState<WorkoutDetail | null>(null);
  const [summaryPrs, setSummaryPrs] = useState<string[]>([]);
  // Handlers read rows from here, not from the render they were created in: a blur or tap can fire
  // before the keystroke that preceded it has re-rendered.
  const blocksRef = useRef<Block[]>([]);
  blocksRef.current = blocks;
  const current = (bi: number, key: string) => blocksRef.current[bi]?.rows.find((x) => x.key === key);

  useEffect(() => {
    api<WorkoutDetail>("GET", `/api/workouts/${id}`)
      .then(async (w) => {
        setWorkout(w);
        const bs = toBlocks(w);
        setBlocks(bs);
        // "Last time" per exercise: the most recent session before this workout's day.
        const lasts = await Promise.all(
          bs.map((b) =>
            api<{ sessions: HistorySession[] }>("GET", `/api/exercises/${encodeURIComponent(b.exerciseId)}/history?to=${dayBefore(w.date)}&limit=1`)
              .then((h) => h.sessions[0]?.sets ?? [])
              .catch(() => []),
          ),
        );
        setBlocks((cur) => cur.map((b, i) => ({ ...b, last: lasts[i] ?? [] })));
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [id]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const startedAt = useMemo(() => {
    if (!workout) return null;
    const performed = workout.exercises.flatMap((e) => e.sets.map((s) => s.performed_at)).filter(Boolean) as string[];
    const first = workout.start_time ?? performed.sort()[0] ?? null;
    return first ? Date.parse(first) : null;
  }, [workout]);

  if (error) return <p class="error pad">{error}</p>;
  if (!workout) return <p class="muted pad">Loading…</p>;

  const update = (bi: number, key: string, patch: Partial<Row>) => {
    const next = (cur: Block[]) => cur.map((b, i) => (i !== bi ? b : { ...b, rows: b.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
    blocksRef.current = next(blocksRef.current);
    setBlocks(next);
  };

  const beginRest = (b: Block) => {
    const t = startRest(Date.now(), b.rest, b.name);
    localStorage.setItem(REST_KEY, JSON.stringify(t));
    setRest(t);
  };

  const bodyFor = (b: Block, r: Row) => {
    const [fa, fb] = fieldsFor(b.exType);
    const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
    const body: Record<string, unknown> = { type: r.type };
    if (fa) body[fa] = num(r.a);
    body[fb] = fb === "reps" || fb === "duration_s" ? (num(r.b) != null ? Math.round(num(r.b)!) : undefined) : num(r.b);
    return body;
  };

  const tick = async (bi: number, key: string) => {
    const b = blocksRef.current[bi]!;
    const r = current(bi, key);
    if (!r) return;
    setError(null);
    if (!r.done) {
      const body = bodyFor(b, r);
      const [, fb] = fieldsFor(b.exType);
      if (body[fb] == null) {
        setError(`Enter ${HEADER[fb]} for ${b.name} set ${r.setNumber}`);
        return;
      }
      update(bi, r.key, { done: true });
      beginRest(b);
      try {
        let res: SetResult | null;
        if (r.serverId && r.target) {
          res = await writeOrQueue<SetResult>({ setKey: r.key, kind: "complete", method: "POST", path: `/api/sets/${r.serverId}/complete`, body });
        } else {
          res = await writeOrQueue<SetResult>({
            setKey: r.key,
            kind: "create",
            method: "POST",
            path: "/api/sets",
            body: { ...body, exercise_id: b.exerciseId, workout_id: workout.id, fill_planned: false },
          });
        }
        update(bi, r.key, res ? { serverId: res.set.id, pr: res.is_pr, pending: false } : { pending: true });
      } catch (e) {
        update(bi, r.key, { done: false });
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    // Un-tick: planned sets go back to planned; sets you added are removed.
    try {
      if (r.target && (r.serverId || r.pending)) {
        update(bi, r.key, { done: false, pr: false });
        const res = await writeOrQueue({ setKey: r.key, kind: "uncomplete", method: "POST", path: `/api/sets/${r.serverId}/uncomplete` });
        update(bi, r.key, { pending: res === null && outbox.pendingFor(r.key) });
      } else {
        setBlocks((cur) => cur.map((x, i) => (i !== bi ? x : { ...x, rows: x.rows.filter((y) => y.key !== r.key) })));
        await writeOrQueue({ setKey: r.key, kind: "delete", method: "DELETE", path: r.serverId ? `/api/sets/${r.serverId}` : "/api/sets/0" });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Editing a set that's already saved updates it on the server when you leave the field. */
  const saveEdit = async (bi: number, key: string) => {
    const r = current(bi, key);
    if (!r || !r.done || !r.serverId || r.pending) return;
    try {
      await writeOrQueue({ setKey: r.key, kind: "update", method: "PATCH", path: `/api/sets/${r.serverId}`, body: bodyFor(blocksRef.current[bi]!, r) });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const setType = async (bi: number, r: Row, type: string) => {
    setTypeMenu(null);
    update(bi, r.key, { type });
    if (r.done && r.serverId && !r.pending) {
      await writeOrQueue({ setKey: r.key, kind: "update", method: "PATCH", path: `/api/sets/${r.serverId}`, body: { type } }).catch(() => null);
    }
  };

  const addSet = (bi: number) =>
    setBlocks((cur) =>
      cur.map((b, i) => {
        if (i !== bi) return b;
        const prev = b.rows[b.rows.length - 1];
        const row: Row = {
          key: `local-${crypto.randomUUID()}`,
          serverId: null,
          setNumber: (prev?.setNumber ?? 0) + 1,
          type: "normal",
          target: null,
          a: prev?.a ?? "",
          b: prev?.b ?? "",
          done: false,
          pending: false,
          pr: false,
        };
        return { ...b, rows: [...b.rows, row] };
      }),
    );

  const addExercise = async (e: ExerciseSummary & { type?: string }) => {
    setPicker(false);
    const detail = await api<{ id: string; name: string; type: string }>("GET", `/api/exercises/${encodeURIComponent(e.id)}`);
    const last = await api<{ sessions: HistorySession[] }>("GET", `/api/exercises/${encodeURIComponent(e.id)}/history?to=${dayBefore(workout.date)}&limit=1`)
      .then((h) => h.sessions[0]?.sets ?? [])
      .catch(() => []);
    setBlocks((cur) => [
      ...cur,
      {
        exerciseId: detail.id,
        name: detail.name,
        exType: detail.type,
        rest: null,
        notes: null,
        superset: null,
        last,
        rows: [{ key: `local-${crypto.randomUUID()}`, serverId: null, setNumber: 1, type: "normal", target: null, a: "", b: "", done: false, pending: false, pr: false }],
      },
    ]);
  };

  const finish = async () => {
    await flushOutbox();
    try {
      await api("PATCH", `/api/workouts/${workout.id}`, { end_time: new Date().toISOString() });
      const [detail, prs] = await Promise.all([
        api<WorkoutDetail>("GET", `/api/workouts/${workout.id}`),
        api<{ prs: { exercise_id: string }[] }>("GET", `/api/workouts/${workout.id}/prs`).catch(() => ({ prs: [] })),
      ]);
      setSummaryPrs(prs.prs.map((p) => detail.exercises.find((e) => e.exercise.id === p.exercise_id)?.exercise.name ?? p.exercise_id));
      setSummary(detail);
      localStorage.removeItem(REST_KEY);
      setRest(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (summary) {
    const prs = summaryPrs;
    const waiting = outbox.list().length;
    return (
      <section class="pad summary">
        <h1>Workout complete</h1>
        <div class="title">{summary.name ?? "Workout"}</div>
        <div class="stats">
          <div>
            <b>{minutes(summary.duration_min) || "—"}</b>
            <span>duration</span>
          </div>
          <div>
            <b>{volume(summary.totals.volume_kg)}</b>
            <span>volume</span>
          </div>
          <div>
            <b>
              {summary.totals.performed_sets}/{summary.totals.performed_sets + summary.totals.planned_sets}
            </b>
            <span>sets vs plan</span>
          </div>
          <div>
            <b>{prs.length}</b>
            <span>PRs</span>
          </div>
        </div>
        {prs.length > 0 && <p>🏆 New PRs: {[...new Set(prs)].join(", ")}</p>}
        {waiting > 0 && <p class="warn">{waiting} change(s) still waiting to sync. Keep the app open when you're back online.</p>}
        <button class="btn primary big" onClick={() => navigate("/", true)}>
          Done
        </button>
      </section>
    );
  }

  return (
    <section class="workout">
      <header class="workout-head">
        <div>
          <div class="title">{workout.name ?? "Workout"}</div>
          <div class="muted small">{startedAt ? formatClock((now - startedAt) / 1000) : "Not started"}</div>
        </div>
        <button class="btn primary" onClick={finish}>
          Finish
        </button>
      </header>
      {error && <p class="error">{error}</p>}

      {blocks.map((b, bi) => {
        const [fa, fb] = fieldsFor(b.exType);
        return (
          <div class="exercise">
            <div class="exercise-head">
              <Link href={`/exercise/${encodeURIComponent(b.exerciseId)}`} class="exercise-name">
                {b.name}
              </Link>
              {b.superset != null && <span class="chip">Superset {b.superset}</span>}
            </div>
            {b.notes && <div class="muted small">{b.notes}</div>}
            <table class="sets">
              <thead>
                <tr>
                  <th>Set</th>
                  <th>Target</th>
                  <th>Last</th>
                  <th>{fa ? (b.exType.startsWith("bodyweight") ? "+kg" : HEADER[fa]) : ""}</th>
                  <th>{HEADER[fb]}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r) => {
                  const last = lastFor(b.last, r.setNumber, r.type);
                  return (
                    <tr class={`${r.done ? "done" : ""} ${r.pending ? "pending" : ""}`}>
                      <td class="set-no">
                        <button class={`set-type ${r.type}`} onClick={() => setTypeMenu(typeMenu === r.key ? null : r.key)} aria-label="Set type">
                          {SET_TYPE_LABEL[r.type] ?? r.setNumber}
                        </button>
                        {typeMenu === r.key && (
                          <div class="type-menu">
                            {(["normal", "warmup", "failure", "dropset"] as const).map((t) => (
                              <button onClick={() => setType(bi, r, t)}>{t === "normal" ? "Normal" : t === "warmup" ? "Warm-up" : t === "failure" ? "Failure" : "Drop set"}</button>
                            ))}
                          </div>
                        )}
                      </td>
                      <td class="target">{describeTarget(r.target) || "—"}</td>
                      <td class="last">{last ? (last as { text?: string }).text ?? "" : "—"}</td>
                      <td>
                        {fa && (
                          <input
                            inputMode="decimal"
                            value={r.a}
                            disabled={r.pending}
                            onInput={(e) => update(bi, r.key, { a: (e.target as HTMLInputElement).value })}
                            onBlur={() => saveEdit(bi, r.key)}
                          />
                        )}
                      </td>
                      <td>
                        <input
                          inputMode={fb === "distance_m" ? "decimal" : "numeric"}
                          value={r.b}
                          disabled={r.pending}
                          onInput={(e) => update(bi, r.key, { b: (e.target as HTMLInputElement).value })}
                          onBlur={() => saveEdit(bi, r.key)}
                        />
                      </td>
                      <td>
                        <button class={`check ${r.done ? "on" : ""}`} onClick={() => tick(bi, r.key)} aria-label={r.done ? "Mark not done" : "Mark done"}>
                          ✓
                        </button>
                        {r.pr && <span class="pr" title="Personal record">PR</span>}
                        {r.pending && <span class="dot" title="Waiting to sync" />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <button class="btn ghost" onClick={() => addSet(bi)}>
              + Add set
            </button>
          </div>
        );
      })}

      <button class="btn ghost wide" onClick={() => setPicker(true)}>
        + Add exercise
      </button>
      <p class="muted small center">Planned sets you don't tick are recorded as skipped.</p>

      {picker && <ExercisePicker onPick={addExercise} onClose={() => setPicker(false)} />}
      {rest && <RestBar timer={rest} onChange={(t) => (t ? localStorage.setItem(REST_KEY, JSON.stringify(t)) : localStorage.removeItem(REST_KEY), setRest(t))} />}
    </section>
  );
}
