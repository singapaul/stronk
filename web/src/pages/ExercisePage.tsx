import { useEffect, useState } from "preact/hooks";
import { api } from "../api.ts";
import { dayLabel, volume } from "../format.ts";
import { Link } from "../router.tsx";
import type { HistorySession } from "../types.ts";

type Prs = {
  records: {
    heaviest?: { load_kg: number; reps: number; date: string };
    best_e1rm?: { e1rm_kg: number; load_kg: number; reps: number; date: string };
    best_reps_at_weight?: { load_kg: number; reps: number; date: string }[];
    longest_duration?: { duration_s: number; date: string };
  }[];
};

export function ExercisePage({ id }: { id: string }) {
  const [name, setName] = useState("");
  const [sessions, setSessions] = useState<HistorySession[] | null>(null);
  const [prs, setPrs] = useState<Prs["records"][number] | null>(null);

  useEffect(() => {
    const e = encodeURIComponent(id);
    void api<{ name: string }>("GET", `/api/exercises/${e}`).then((x) => setName(x.name));
    void api<{ sessions: HistorySession[] }>("GET", `/api/exercises/${e}/history?limit=15`).then((h) => setSessions(h.sessions));
    void api<Prs>("GET", `/api/prs?exercise_id=${e}`).then((p) => setPrs(p.records[0] ?? null));
  }, [id]);

  return (
    <section class="pad">
      <button class="link back" onClick={() => history.back()}>
        ‹ Back
      </button>
      <h1>{name || "Exercise"}</h1>
      {prs && (
        <div class="stats">
          {prs.heaviest && (
            <div>
              <b>
                {prs.heaviest.load_kg}×{prs.heaviest.reps}
              </b>
              <span>heaviest</span>
            </div>
          )}
          {prs.best_e1rm && (
            <div>
              <b>{prs.best_e1rm.e1rm_kg}</b>
              <span>best e1RM</span>
            </div>
          )}
          {prs.longest_duration && (
            <div>
              <b>{prs.longest_duration.duration_s}s</b>
              <span>longest</span>
            </div>
          )}
        </div>
      )}
      {prs?.best_reps_at_weight && prs.best_reps_at_weight.length > 0 && (
        <p class="muted small">Best reps: {prs.best_reps_at_weight.slice(0, 6).map((b) => `${b.load_kg}×${b.reps}`).join(" · ")}</p>
      )}
      <h2>Sessions</h2>
      {sessions?.length === 0 && <p class="muted">Not logged yet.</p>}
      {sessions?.map((s) => (
        <Link href={`/history/${s.workout_id}`} class="card session">
          <div class="history-top">
            <span>{dayLabel(s.date)}</span>
            <span class="muted small">
              {s.e1rm_kg ? `e1RM ${s.e1rm_kg} · ` : ""}
              {volume(s.volume_kg)}
            </span>
          </div>
          <div class="small">{s.summary}</div>
        </Link>
      ))}
    </section>
  );
}
