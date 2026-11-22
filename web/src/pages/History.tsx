import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { dayLabel, minutes, volume } from "../format.ts";
import { Link } from "../router.tsx";
import type { WorkoutSummary } from "../types.ts";

const PAGE = 20;

export function History() {
  const [items, setItems] = useState<WorkoutSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ workouts: WorkoutSummary[] }>("GET", `/api/workouts?limit=${PAGE}&offset=${offset}`)
      .then((r) => {
        setItems((cur) => [...cur, ...r.workouts.filter((w) => w.performed_sets > 0)]);
        setMore(r.workouts.length === PAGE);
      })
      .catch((e) => setError(String(e.message)));
  }, [offset]);

  return (
    <section class="pad">
      <h1>History</h1>
      {error && <p class="error">{error}</p>}
      {items.length === 0 && !more && <p class="muted">No workouts logged yet.</p>}
      <div class="history">
        {items.map((w) => (
          <Link href={`/history/${w.id}`} class="card history-item">
            <div class="history-top">
              <span class="routine-name">{w.name ?? "Workout"}</span>
              <span class="muted small">{dayLabel(w.date)}</span>
            </div>
            <div class="muted small">
              {[w.cycle_number ? `Cycle ${w.cycle_number}` : null, minutes(w.duration_min), volume(w.volume_kg), `${w.performed_sets} sets`]
                .filter(Boolean)
                .join(" · ")}
            </div>
            <div class="history-lifts">{w.exercises.join(", ")}</div>
          </Link>
        ))}
      </div>
      {more && (
        <button class="btn ghost wide" onClick={() => setOffset(offset + PAGE)}>
          Load more
        </button>
      )}
    </section>
  );
}
