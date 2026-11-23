import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { COPY } from "../copy.ts";
import { dayLabel, minutes, todayIso, volume } from "../format.ts";
import { Link } from "../router.tsx";
import type { WorkoutSummary } from "../types.ts";
import { shortName } from "./WorkoutTab.tsx";

const PAGE = 20;

/** Monday of the week a date falls in, as YYYY-MM-DD. */
export function weekStart(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function weekTitle(start: string, thisWeek: string): string {
  if (start === thisWeek) return COPY.history.thisWeek;
  const last = new Date(`${thisWeek}T12:00:00Z`);
  last.setUTCDate(last.getUTCDate() - 7);
  if (start === last.toISOString().slice(0, 10)) return COPY.history.lastWeek;
  return `Week of ${dayLabel(start)}`;
}

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

  const thisWeek = weekStart(todayIso());
  const weeks = new Map<string, WorkoutSummary[]>();
  for (const w of items) {
    const k = weekStart(w.date);
    weeks.set(k, [...(weeks.get(k) ?? []), w]);
  }

  return (
    <section class="page enter">
      <h1>{COPY.history.title}</h1>
      {error && <p class="error">{error}</p>}
      {items.length === 0 && !more && (
        <div class="card m-nolift empty">
          <p class="lead">{COPY.history.empty}</p>
        </div>
      )}
      {[...weeks.entries()].map(([start, ws]) => (
        <section class="week" aria-label={weekTitle(start, thisWeek)}>
          <h2>{weekTitle(start, thisWeek)}</h2>
          {ws.map((w) => (
            <Link href={`/history/${w.id}`} class="card hist">
              <div class="hist__top">
                <span class="hist__name">{shortName(w.name ?? "Workout")}</span>
                <span class="muted small">{dayLabel(w.date)}</span>
              </div>
              <div class="hist__meta">
                {w.cycle_number && <span class="chip">Cycle {w.cycle_number}</span>}
                {w.duration_min != null && <span class="num">{minutes(w.duration_min)}</span>}
                <span class="num">{volume(w.volume_kg)}</span>
                <span>{w.performed_sets} sets</span>
                <span style={{ marginLeft: "auto", display: "inline-flex" }}>
                  <Icon name="chevronRight" size={18} />
                </span>
              </div>
            </Link>
          ))}
        </section>
      ))}
      {more && (
        <button class="btn btn--secondary btn--block" onClick={() => setOffset(offset + PAGE)}>
          {COPY.history.more}
        </button>
      )}
    </section>
  );
}
