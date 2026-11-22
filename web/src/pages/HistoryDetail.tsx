import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.ts";
import { dayLabel, minutes, SET_TYPE_LABEL, volume } from "../format.ts";
import { describeTarget } from "../lib/prefill.ts";
import { Link, navigate } from "../router.tsx";
import type { SetOut, WorkoutDetail } from "../types.ts";

function performedText(s: SetOut): string {
  const rpe = s.rpe != null ? ` @${s.rpe}` : "";
  if (s.reps == null && s.duration_s != null) return `${s.duration_s}s${rpe}`;
  if (s.reps == null && s.distance_m != null) return `${s.distance_m}m${rpe}`;
  return `${s.weight_kg != null ? `${s.weight_kg}×` : ""}${s.reps ?? "?"}${s.weight_kg == null ? " reps" : ""}${rpe}`;
}

export function HistoryDetail({ id }: { id: number }) {
  const [w, setW] = useState<WorkoutDetail | null>(null);
  const [editing, setEditing] = useState<SetOut | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api<WorkoutDetail>("GET", `/api/workouts/${id}`).then(setW).catch((e) => setError(String(e.message)));
  useEffect(() => void load(), [id]);

  if (error) return <p class="error pad">{error}</p>;
  if (!w) return <p class="muted pad">Loading…</p>;

  return (
    <section class="pad">
      <button class="link back" onClick={() => history.back()}>
        ‹ Back
      </button>
      <h1>{w.name ?? "Workout"}</h1>
      <p class="muted small">
        {[dayLabel(w.date), minutes(w.duration_min), volume(w.totals.volume_kg), `${w.totals.performed_sets} sets`].filter(Boolean).join(" · ")}
      </p>
      {w.status !== "completed" && !w.end_time && w.totals.planned_sets > 0 && (
        <button class="btn primary" onClick={() => navigate(`/w/${w.id}`)}>
          Continue this workout
        </button>
      )}
      {w.exercises.map((e) => (
        <div class="card">
          <Link href={`/exercise/${encodeURIComponent(e.exercise.id)}`} class="exercise-name">
            {e.exercise.name}
          </Link>
          <ul class="detail-sets">
            {e.sets.map((s) => (
              <li class={s.is_planned ? "skipped" : ""}>
                <span class={`set-type ${s.type}`}>{SET_TYPE_LABEL[s.type] ?? s.set_number}</span>
                <span>{s.is_planned ? "Skipped" : performedText(s)}</span>
                <span class="muted small">{s.target ? `target ${describeTarget(s.target)}` : ""}</span>
                {!s.is_planned && (
                  <button class="link" onClick={() => setEditing(s)}>
                    Edit
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {editing && <EditSet set={editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), void load())} />}
    </section>
  );
}

function EditSet({ set, onClose, onSaved }: { set: SetOut; onClose: () => void; onSaved: () => void }) {
  const [kg, setKg] = useState(set.weight_kg?.toString() ?? "");
  const [reps, setReps] = useState(set.reps?.toString() ?? "");
  const [rpe, setRpe] = useState(set.rpe?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const n = (s: string) => (s.trim() === "" ? null : Number(s));
  // Read the fields directly on save (a tap can land before the last keystroke re-renders).
  const kgRef = useRef<HTMLInputElement>(null);
  const repsRef = useRef<HTMLInputElement>(null);
  const rpeRef = useRef<HTMLInputElement>(null);

  const save = async () => {
    try {
      await api("PATCH", `/api/sets/${set.id}`, {
        weight_kg: n(kgRef.current?.value ?? kg),
        reps: n(repsRef.current?.value ?? reps),
        rpe: n(rpeRef.current?.value ?? rpe),
      });
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
    <div class="sheet-backdrop" onClick={onClose}>
      <div class="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Edit set {set.set_number}</h2>
        {error && <p class="error">{error}</p>}
        <div class="form-row">
          <label>
            kg
            <input ref={kgRef} inputMode="decimal" value={kg} onInput={(e) => setKg((e.target as HTMLInputElement).value)} />
          </label>
          <label>
            reps
            <input ref={repsRef} inputMode="numeric" value={reps} onInput={(e) => setReps((e.target as HTMLInputElement).value)} />
          </label>
          <label>
            RPE
            <input ref={rpeRef} inputMode="decimal" value={rpe} onInput={(e) => setRpe((e.target as HTMLInputElement).value)} />
          </label>
        </div>
        <div class="sheet-actions">
          <button class="btn danger" onClick={remove}>
            Delete
          </button>
          <button class="btn primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
