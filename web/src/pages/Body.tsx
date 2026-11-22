import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.ts";
import { dayLabel, todayIso } from "../format.ts";
import type { BodyweightEntry } from "../types.ts";

type List = { entries: BodyweightEntry[]; latest: BodyweightEntry | null; change_kg: number | null };

export function Body({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const [data, setData] = useState<List | null>(null);
  const [weight, setWeight] = useState("");
  const [date, setDate] = useState(todayIso());
  const [msg, setMsg] = useState<string | null>(null);
  // Save reads the fields directly: a tap on Save can arrive before the last keystroke re-renders.
  const weightRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);

  const load = () =>
    api<List>("GET", "/api/bodyweight?limit=30").then((d) => {
      setData(d);
      if (!weight && d.latest?.weight_kg) setWeight(String(d.latest.weight_kg));
    });
  useEffect(() => void load(), []);

  const save = async () => {
    const w = Number(weightRef.current?.value ?? weight);
    const day = dateRef.current?.value || date;
    if (!w) return setMsg("Enter your weight in kg");
    try {
      await api("PUT", `/api/bodyweight/${day}`, { weight_kg: w });
      setMsg(`Saved ${w} kg for ${dayLabel(day)}`);
      void load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section class="pad">
      <h1>Body</h1>
      <div class="card">
        <div class="form-row">
          <label>
            Weight (kg)
            <input ref={weightRef} inputMode="decimal" value={weight} onInput={(e) => setWeight((e.target as HTMLInputElement).value)} />
          </label>
          <label>
            Date
            <input ref={dateRef} type="date" value={date} max={todayIso()} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
          </label>
        </div>
        <button class="btn primary wide" onClick={save}>
          Save
        </button>
        {msg && <p class="muted small">{msg}</p>}
      </div>
      {data && data.entries.length > 0 && (
        <>
          <h2>
            Recent
            {data.change_kg != null && (
              <span class="muted small"> · {data.change_kg > 0 ? "+" : ""}{data.change_kg} kg over this list</span>
            )}
          </h2>
          <ul class="card list">
            {data.entries.map((e) => (
              <li>
                <span>{dayLabel(e.date)}</span>
                <span>{e.weight_kg != null ? `${e.weight_kg} kg` : "—"}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p class="muted small center">
        Signed in as {email} ·{" "}
        <button class="link" onClick={onSignOut}>
          Sign out
        </button>
      </p>
    </section>
  );
}
