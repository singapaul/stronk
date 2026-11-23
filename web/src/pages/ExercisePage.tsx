import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { Trend } from "../components/Trend.tsx";
import { COPY } from "../copy.ts";
import { dayLabel, volume } from "../format.ts";
import { sessionSeries } from "../lib/trend.ts";
import { Link } from "../router.tsx";
import type { HistorySession } from "../types.ts";

type Detail = { id: string; name: string; equipment: string | null; primary_muscles: string[]; instructions: string[]; images: string[] };
type Prs = {
  records: {
    heaviest?: { load_kg: number; reps: number; date: string };
    best_e1rm?: { e1rm_kg: number; load_kg: number; reps: number; date: string };
    best_reps_at_weight?: { load_kg: number; reps: number }[];
    longest_duration?: { duration_s: number; date: string };
  }[];
};

/** Library text is lower case ("quadriceps · barbell"); labels are sentence case. */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function ExercisePage({ id }: { id: string }) {
  const [ex, setEx] = useState<Detail | null>(null);
  const [sessions, setSessions] = useState<HistorySession[] | null>(null);
  const [prs, setPrs] = useState<Prs["records"][number] | null>(null);

  useEffect(() => {
    const e = encodeURIComponent(id);
    void api<Detail>("GET", `/api/exercises/${e}`).then(setEx);
    void api<{ sessions: HistorySession[] }>("GET", `/api/exercises/${e}/history?limit=20`).then((h) => setSessions(h.sessions));
    void api<Prs>("GET", `/api/prs?exercise_id=${e}`).then((p) => setPrs(p.records[0] ?? null));
  }, [id]);

  const series = sessions ? sessionSeries(sessions) : null;

  return (
    <section class="page enter">
      <button class="back" onClick={() => history.back()}>
        <Icon name="chevronLeft" size={18} /> Back
      </button>
      <div class="page-head">
        <span class="label">{sentence([ex?.primary_muscles.join(", "), ex?.equipment].filter(Boolean).join(" · "))}</span>
        <h1>{ex?.name ?? "Exercise"}</h1>
      </div>

      {series && series.points.length >= 2 && (
        <div class="card m-nolift">
          <div class="kv" style={{ paddingTop: 0 }}>
            <h2>{COPY.exercise.trend}</h2>
            <span class="label">{series.label}</span>
          </div>
          <Trend points={series.points} unit={series.unit} label={series.label} />
        </div>
      )}

      {prs && (
        <div class="stats">
          {prs.best_e1rm && (
            <div class="stat">
              <b class="num">{prs.best_e1rm.e1rm_kg}</b>
              <span class="label">Best e1RM (kg)</span>
            </div>
          )}
          {prs.heaviest && (
            <div class="stat">
              <b class="num">
                {prs.heaviest.load_kg} × {prs.heaviest.reps}
              </b>
              <span class="label">Heaviest set</span>
            </div>
          )}
          {prs.longest_duration && (
            <div class="stat">
              <b class="num">{prs.longest_duration.duration_s}s</b>
              <span class="label">Longest hold</span>
            </div>
          )}
        </div>
      )}

      <section class="week">
        <h2>{COPY.exercise.sessions}</h2>
        {sessions?.length === 0 && <p class="lead">{COPY.exercise.none}</p>}
        {sessions?.map((s) => (
          <Link href={`/history/${s.workout_id}`} class="card hist">
            <div class="hist__top">
              <span>{dayLabel(s.date)}</span>
              <span class="muted small num">
                {s.e1rm_kg ? `e1RM ${s.e1rm_kg} · ` : ""}
                {volume(s.volume_kg)}
              </span>
            </div>
            <div class="small num">{s.summary}</div>
          </Link>
        ))}
      </section>

      {ex && (ex.instructions.length > 0 || ex.images.length > 0) && (
        <details class="card m-nolift">
          <summary>{COPY.exercise.howTo}</summary>
          {ex.images[0] && <img class="ex-img" src={ex.images[0]} alt={`${ex.name}, start position`} loading="lazy" />}
          <ol class="small" style={{ paddingLeft: 18, display: "grid", gap: 6 }}>
            {ex.instructions.map((i) => (
              <li>{i}</li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
