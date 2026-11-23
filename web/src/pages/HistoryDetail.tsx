import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { Sheet } from "../components/Sheet.tsx";
import { dayLabel, minutes, SET_TYPE_LABEL, volume } from "../format.ts";
import { describeTarget } from "../lib/prefill.ts";
import { Link, navigate } from "../router.tsx";
import type { SetOut, WorkoutDetail } from "../types.ts";
import { shortName } from "./WorkoutTab.tsx";

function performedText(s: SetOut): string {
  const rpe = s.rpe != null ? ` @${s.rpe}` : "";
  if (s.reps == null && s.duration_s != null) return `${s.duration_s}s${rpe}`;
  if (s.reps == null && s.distance_m != null) return `${s.distance_m} m${rpe}`;
  return `${s.weight_kg != null ? `${s.weight_kg} × ` : ""}${s.reps ?? "?"}${s.weight_kg == null ? " reps" : ""}${rpe}`;
}

export function HistoryDetail({ id }: { id: number }) {
  const [w, setW] = useState<WorkoutDetail | null>(null);
  const [prs, setPrs] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<SetOut | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    void api<WorkoutDetail>("GET", `/api/workouts/${id}`).then(setW).catch((e) => setError(String(e.message)));
    void api<{ prs: { set_id: number }[] }>("GET", `/api/workouts/${id}/prs`)
      .then((r) => setPrs(new Set(r.prs.map((p) => p.set_id))))
      .catch(() => null);
  };
  useEffect(load, [id]);

  if (error) return <p class="error page">{error}</p>;
  if (!w) return <div class="page" aria-busy="true" />;

  return (
    <section class="page enter">
      <button class="back" onClick={() => history.back()}>
        <Icon name="chevronLeft" size={18} /> Back
      </button>
      <div class="page-head">
        <span class="label">{dayLabel(w.date)}</span>
        <h1>{shortName(w.name ?? "Workout")}</h1>
      </div>
      <div class="stats">
        <div class="stat">
          <b class="num">{minutes(w.duration_min) || "—"}</b>
          <span class="label">Duration</span>
        </div>
        <div class="stat">
          <b class="num">{volume(w.totals.volume_kg)}</b>
          <span class="label">Volume</span>
        </div>
      </div>
      {w.status !== "completed" && !w.end_time && w.totals.planned_sets > 0 && (
        <button class="btn btn--primary btn--block" onClick={() => navigate(`/w/${w.id}`)}>
          Continue this workout
        </button>
      )}
      {w.exercises.map((e) => (
        <article class="card m-nolift block">
          <div class="block__title">
            <Link href={`/exercise/${encodeURIComponent(e.exercise.id)}`}>{e.exercise.name}</Link>
          </div>
          <ul class="row-list">
            {e.sets.map((s) => (
              <li class={`detail-set ${s.is_planned ? "is-skipped" : ""}`}>
                <span class={`set__no ${s.type}`}>{SET_TYPE_LABEL[s.type] ?? s.set_number}</span>
                <span>
                  <span class="num">{s.is_planned ? "Skipped" : performedText(s)}</span>
                  {prs.has(s.id) && (
                    <span class="set__pr" style={{ marginLeft: 8 }}>
                      <Icon name="trophy" size={14} /> PR
                    </span>
                  )}
                  {s.target && <span class="muted small" style={{ display: "block" }}>Target {describeTarget(s.target)}</span>}
                </span>
                {!s.is_planned ? (
                  <button class="icon-btn" onClick={() => setEditing(s)} aria-label={`Edit set ${s.set_number}`}>
                    <Icon name="ellipsis" size={18} />
                  </button>
                ) : (
                  <span />
                )}
              </li>
            ))}
          </ul>
        </article>
      ))}
      {editing && <EditSet set={editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), load())} />}
    </section>
  );
}

function EditSet({ set, onClose, onSaved }: { set: SetOut; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const n = (s: string | undefined) => (!s || s.trim() === "" ? null : Number(s));
  // Read the fields directly on save (a tap can land before the last keystroke re-renders).
  const kgRef = useRef<HTMLInputElement>(null);
  const repsRef = useRef<HTMLInputElement>(null);
  const rpeRef = useRef<HTMLInputElement>(null);

  const save = async () => {
    try {
      await api("PATCH", `/api/sets/${set.id}`, { weight_kg: n(kgRef.current?.value), reps: n(repsRef.current?.value), rpe: n(rpeRef.current?.value) });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const remove = async () => {
    if (!confirm("Delete this set?")) return;
    await api("DELETE", `/api/sets/${set.id}`);
    onSaved();
  };

  return (
    <Sheet title={`Edit set ${set.set_number}`} onClose={onClose}>
      {error && <p class="error">{error}</p>}
      <div class="form-grid">
        <label class="field">
          kg
          <input ref={kgRef} inputMode="decimal" defaultValue={set.weight_kg?.toString() ?? ""} />
        </label>
        <label class="field">
          Reps
          <input ref={repsRef} inputMode="numeric" defaultValue={set.reps?.toString() ?? ""} />
        </label>
        <label class="field">
          RPE
          <input ref={rpeRef} inputMode="decimal" defaultValue={set.rpe?.toString() ?? ""} />
        </label>
      </div>
      <div class="btn-row" style={{ justifyContent: "space-between" }}>
        <button class="btn btn--secondary" onClick={remove}>
          Delete set
        </button>
        <button class="btn btn--primary" onClick={save}>
          Save set
        </button>
      </div>
    </Sheet>
  );
}
