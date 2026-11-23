import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ACTIVE_KEY } from "../app.tsx";
import { api, ApiError, flushOutbox, outbox, writeOrQueue } from "../api.ts";
import { ExercisePicker } from "../components/ExercisePicker.tsx";
import { Icon } from "../components/Icon.tsx";
import { RestSheet } from "../components/RestSheet.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { Stepper } from "../components/Stepper.tsx";
import { COPY } from "../copy.ts";
import { dayBefore, dayLabel, minutes, SET_TYPE_LABEL, volume } from "../format.ts";
import { describeTarget } from "../lib/prefill.ts";
import { groupBlocks, nextUp, type Entry, type Group } from "../lib/rounds.ts";
import { formatClock, startRest, type RestTimer } from "../lib/timer.ts";
import { Link, navigate } from "../router.tsx";
import type { ExerciseSummary, HistorySession, SetResult, Target, WorkoutDetail } from "../types.ts";
import { shortName } from "./WorkoutTab.tsx";

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
const UNIT: Record<FieldKey, string> = { weight_kg: "kg", reps: "reps", duration_s: "sec", distance_m: "m" };
const STEP: Record<FieldKey, number> = { weight_kg: 2.5, reps: 1, duration_s: 5, distance_m: 10 };
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
  last: { date: string; summary: string } | null;
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
      last: null,
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

const lastOf = (date: string) => (h: { sessions: HistorySession[] }) => {
  const s = h.sessions[0];
  return s ? { date: s.date, summary: s.summary } : null;
};

export function ActiveWorkout({ id }: { id: number }) {
  const [workout, setWorkout] = useState<WorkoutDetail | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rest, setRest] = useState<RestTimer | null>(readRest);
  const [restCollapsed, setRestCollapsed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [picker, setPicker] = useState(false);
  const [typeFor, setTypeFor] = useState<{ bi: number; key: string } | null>(null);
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
              .then(lastOf(w.date))
              .catch(() => null),
          ),
        );
        setBlocks((cur) => cur.map((b, i) => ({ ...b, last: lasts[i] ?? null })));
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [id]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    // The rest timer folds away while you scroll or type, and comes back with a tap.
    const fold = () => setRestCollapsed(true);
    const onFocus = (e: FocusEvent) => (e.target as HTMLElement)?.tagName === "INPUT" && fold();
    window.addEventListener("scroll", fold, { passive: true });
    window.addEventListener("focusin", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("scroll", fold);
      window.removeEventListener("focusin", onFocus);
    };
  }, []);

  const startedAt = useMemo(() => {
    if (!workout) return null;
    const performed = workout.exercises.flatMap((e) => e.sets.map((s) => s.performed_at)).filter(Boolean) as string[];
    const first = workout.start_time ?? performed.sort()[0] ?? null;
    return first ? Date.parse(first) : null;
  }, [workout]);

  const groups: Group[] = useMemo(() => groupBlocks(blocks.map((b) => ({ superset: b.superset, rows: b.rows }))), [blocks]);
  const tags = useMemo(() => {
    const t = new Map<number, string>();
    for (const g of groups) if (g.kind === "superset") for (const m of g.members) t.set(m.block, m.tag);
    return t;
  }, [groups]);

  if (error && !workout) return <p class="error page">{error}</p>;
  if (!workout) return <div class="page" aria-busy="true" />;

  const plainBlocks = () => blocksRef.current.map((b) => ({ superset: b.superset, rows: b.rows }));
  const upNext = nextUp(groups, plainBlocks());

  const update = (bi: number, key: string, patch: Partial<Row>) => {
    const next = (cur: Block[]) => cur.map((b, i) => (i !== bi ? b : { ...b, rows: b.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
    blocksRef.current = next(blocksRef.current);
    setBlocks(next);
  };

  const describeEntry = (e: Entry | null): string => {
    if (!e) return COPY.log.allDone;
    const b = blocksRef.current[e.block]!;
    const r = b.rows.find((x) => x.key === e.row)!;
    const t = describeTarget(r.target);
    return `${tags.get(e.block) ? `${tags.get(e.block)} ` : ""}${b.name}${t ? ` · ${t}` : ""}`;
  };

  const beginRest = (bi: number, key: string) => {
    const b = blocksRef.current[bi]!;
    const after = nextUp(groupBlocks(plainBlocks()), plainBlocks(), { block: bi, row: key });
    const t = startRest(Date.now(), b.rest, describeEntry(after));
    localStorage.setItem(REST_KEY, JSON.stringify(t));
    setRest(t);
    setRestCollapsed(false);
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
        setError(COPY.log.enter(UNIT[fb]));
        return;
      }
      update(bi, r.key, { done: true });
      beginRest(bi, r.key);
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

  const setType = async (bi: number, key: string, type: string) => {
    setTypeFor(null);
    const r = current(bi, key);
    if (!r) return;
    update(bi, key, { type });
    if (r.done && r.serverId && !r.pending) {
      await writeOrQueue({ setKey: key, kind: "update", method: "PATCH", path: `/api/sets/${r.serverId}`, body: { type } }).catch(() => null);
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

  const addExercise = async (e: ExerciseSummary) => {
    setPicker(false);
    const detail = await api<{ id: string; name: string; type: string }>("GET", `/api/exercises/${encodeURIComponent(e.id)}`);
    const last = await api<{ sessions: HistorySession[] }>("GET", `/api/exercises/${encodeURIComponent(e.id)}/history?to=${dayBefore(workout.date)}&limit=1`)
      .then(lastOf(workout.date))
      .catch(() => null);
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
      setSummaryPrs([...new Set(prs.prs.map((p) => detail.exercises.find((e) => e.exercise.id === p.exercise_id)?.exercise.name ?? p.exercise_id))]);
      setSummary(detail);
      localStorage.removeItem(REST_KEY);
      localStorage.removeItem(ACTIVE_KEY);
      setRest(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (summary) {
    const waiting = outbox.list().length;
    return (
      <section class="page enter">
        <div class="page-head">
          <span class="label">{shortName(summary.name ?? "Workout")}</span>
          <h1>{COPY.summary.title}</h1>
        </div>
        <div class="stats">
          <div class="stat">
            <b class="num">{minutes(summary.duration_min) || "—"}</b>
            <span class="label">Duration</span>
          </div>
          <div class="stat">
            <b class="num">{volume(summary.totals.volume_kg)}</b>
            <span class="label">Volume</span>
          </div>
          <div class="stat">
            <b class="num">
              {summary.totals.performed_sets}/{summary.totals.performed_sets + summary.totals.planned_sets}
            </b>
            <span class="label">Sets against the plan</span>
          </div>
          <div class="stat">
            <b class="num">{summaryPrs.length}</b>
            <span class="label">Personal records</span>
          </div>
        </div>
        {summaryPrs.length > 0 && (
          <div class="card m-nolift">
            <h2>{COPY.summary.prs}</h2>
            <ul class="row-list">
              {summaryPrs.map((name) => (
                <li class="kv">
                  <span>{name}</span>
                  <Icon name="trophy" size={18} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {waiting > 0 && <p class="note">{COPY.log.queued}</p>}
        <button class="btn btn--primary btn--lg btn--block" onClick={() => navigate("/", true)}>
          {COPY.summary.done}
        </button>
      </section>
    );
  }

  const total = blocks.reduce((n, b) => n + b.rows.length, 0);
  const doneCount = blocks.reduce((n, b) => n + b.rows.filter((r) => r.done).length, 0);

  const setRow = (bi: number, r: Row, showName: boolean) => {
    const b = blocks[bi]!;
    const [fa, fb] = fieldsFor(b.exType);
    const isNext = !r.done && upNext?.block === bi && upNext.row === r.key;
    const t = describeTarget(r.target);
    return (
      <div class={`set ${r.done ? "is-done" : ""} ${isNext ? "is-next" : ""}`}>
        <button class={`set__no ${r.type}`} onClick={() => setTypeFor({ bi, key: r.key })} aria-label={`${b.name} set ${r.setNumber} type: ${COPY.log.types[r.type as keyof typeof COPY.log.types] ?? r.type}`}>
          {SET_TYPE_LABEL[r.type] ?? r.setNumber}
        </button>
        <div class="set__top">
          {showName && <span class="set__who">{tags.get(bi) ? `${tags.get(bi)} · ` : ""}{b.name}</span>}
          {r.pr && (
            <span class="set__pr">
              <Icon name="trophy" size={14} /> PR
            </span>
          )}
          {r.pending && <span class="set__pending" title="Waiting to sync" aria-label="Waiting to sync" />}
          {t && <span class="set__target">{t}</span>}
        </div>
        <div class="set__controls">
          {fa ? (
            <Stepper
              value={r.a}
              step={STEP[fa]}
              unit={b.exType.startsWith("bodyweight") ? "+kg" : UNIT[fa]}
              label={`${b.name} set ${r.setNumber} ${UNIT[fa]}`}
              decimal
              disabled={r.pending}
              onInput={(v) => update(bi, r.key, { a: v })}
              onCommit={() => saveEdit(bi, r.key)}
            />
          ) : null}
          <Stepper
            wide={!fa}
            value={r.b}
            step={STEP[fb]}
            unit={UNIT[fb]}
            label={`${b.name} set ${r.setNumber} ${UNIT[fb]}`}
            decimal={fb === "distance_m"}
            min={0}
            disabled={r.pending}
            onInput={(v) => update(bi, r.key, { b: v })}
            onCommit={() => saveEdit(bi, r.key)}
          />
          <button class={`tick ${r.done ? "is-on" : ""}`} onClick={() => tick(bi, r.key)} aria-label={r.done ? `Undo ${b.name} set ${r.setNumber}` : `Log ${b.name} set ${r.setNumber}`} aria-pressed={r.done}>
            <Icon name="check" size={24} />
          </button>
        </div>
      </div>
    );
  };

  const exerciseHead = (bi: number) => {
    const b = blocks[bi]!;
    return (
      <div class="block__head">
        <div class="block__title">
          {tags.get(bi) && <span class="block__tag">{tags.get(bi)}</span>}
          <Link href={`/exercise/${encodeURIComponent(b.exerciseId)}`}>{b.name}</Link>
        </div>
        {b.notes && <p class="note clamp">{b.notes}</p>}
        {b.last && (
          <p class="last-line">
            {COPY.log.last} · {dayLabel(b.last.date)}: <span class="num">{b.last.summary}</span>
          </p>
        )}
      </div>
    );
  };

  const blockOfRow = (e: Entry) => blocks[e.block]!.rows.find((r) => r.key === e.row)!;

  return (
    <section>
      <header class="wk-head">
        <button class="icon-btn" onClick={() => navigate("/")} aria-label="Back to today">
          <Icon name="chevronLeft" size={20} />
        </button>
        <div class="grow">
          <h1 class="title">{shortName(workout.name ?? "Workout")}</h1>
          <div class="muted small num">
            {startedAt ? formatClock((now - startedAt) / 1000) : "0:00"} · {doneCount}/{total} sets
          </div>
        </div>
        <button class="btn btn--primary" onClick={finish}>
          {COPY.log.finish.replace(" workout", "")}
        </button>
      </header>
      <div class="wk-progress" aria-hidden="true">
        <div style={{ width: `${total ? (doneCount / total) * 100 : 0}%` }} />
      </div>

      <div class="wk-body">
        {error && (
          <p class="error" role="alert">
            {error}
          </p>
        )}
        {groups.map((g) =>
          g.kind === "superset" ? (
            <article class="card m-nolift block">
              <div class="block__head">
                <span class="label">Superset {g.letter}</span>
                <div class="ss-members">{g.members.map((m) => exerciseHead(m.block))}</div>
              </div>
              {g.rounds.map((round) => (
                <div class="round">
                  <span class="round__label">{round.label}</span>
                  {round.entries.map((e) => setRow(e.block, blockOfRow(e), true))}
                </div>
              ))}
              <div class="add-row">
                {g.members.map((m) => (
                  <button class="btn btn--secondary" onClick={() => addSet(m.block)}>
                    <Icon name="plus" size={16} /> {m.tag}
                  </button>
                ))}
              </div>
            </article>
          ) : (
            <article class="card m-nolift block">
              {exerciseHead(g.block)}
              {g.rounds.map((round) => (
                <div class="round">
                  {round.label === "Warm-up" && <span class="round__label">{round.label}</span>}
                  {round.entries.map((e) => setRow(e.block, blockOfRow(e), false))}
                </div>
              ))}
              <div class="add-row">
                <button class="btn btn--secondary" onClick={() => addSet(g.block)}>
                  <Icon name="plus" size={16} /> {COPY.log.addSet}
                </button>
              </div>
            </article>
          ),
        )}
        <button class="btn btn--secondary btn--block" onClick={() => setPicker(true)}>
          <Icon name="plus" size={18} /> {COPY.log.addExercise}
        </button>
        <p class="note" style={{ textAlign: "center" }}>
          {COPY.log.skippedNote}
        </p>
      </div>

      {picker && <ExercisePicker onPick={addExercise} onClose={() => setPicker(false)} />}
      {typeFor && (
        <Sheet title={COPY.log.setType} onClose={() => setTypeFor(null)}>
          <div role="radiogroup" aria-label={COPY.log.setType}>
            {(["normal", "warmup", "failure", "dropset"] as const).map((t) => {
              const checked = current(typeFor.bi, typeFor.key)?.type === t;
              return (
                <button class="option" role="radio" aria-checked={checked} onClick={() => setType(typeFor.bi, typeFor.key, t)}>
                  <span>{COPY.log.types[t]}</span>
                  {checked && <Icon name="check" size={18} />}
                </button>
              );
            })}
          </div>
        </Sheet>
      )}
      {rest && (
        <RestSheet
          timer={rest}
          collapsed={restCollapsed}
          onExpand={() => setRestCollapsed(false)}
          onChange={(t) => {
            if (t) localStorage.setItem(REST_KEY, JSON.stringify(t));
            else localStorage.removeItem(REST_KEY);
            setRest(t);
          }}
        />
      )}
    </section>
  );
}
