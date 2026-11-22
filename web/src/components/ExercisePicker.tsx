import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.ts";
import type { ExerciseSummary } from "../types.ts";

export function ExercisePicker({ onPick, onClose }: { onPick: (e: ExerciseSummary) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ExerciseSummary[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const t = setTimeout(() => {
      const path = q.trim() ? `/api/exercises?q=${encodeURIComponent(q)}&limit=20` : "/api/exercises?limit=20";
      api<{ results: ExerciseSummary[] }>("GET", path)
        .then((r) => setResults(r.results))
        .catch(() => setResults([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div class="sheet-backdrop" onClick={onClose}>
      <div class="sheet" onClick={(e) => e.stopPropagation()}>
        <div class="sheet-head">
          <input ref={input} placeholder="Search exercises" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          <button class="link" onClick={onClose}>
            Cancel
          </button>
        </div>
        <ul class="picker">
          {results.map((r) => (
            <li>
              <button onClick={() => onPick(r)}>
                <span>{r.name}</span>
                <span class="muted small">
                  {[r.equipment, r.primary_muscles.join(", ")].filter(Boolean).join(" · ")}
                  {r.times_logged ? ` · logged ${r.times_logged}×` : ""}
                </span>
              </button>
            </li>
          ))}
          {results.length === 0 && <li class="muted pad">No matches</li>}
        </ul>
      </div>
    </div>
  );
}
