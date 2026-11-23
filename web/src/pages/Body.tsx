import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.ts";
import { Icon } from "../components/Icon.tsx";
import { Stepper } from "../components/Stepper.tsx";
import { Trend } from "../components/Trend.tsx";
import { COPY } from "../copy.ts";
import { dayLabel, todayIso } from "../format.ts";
import type { BodyweightEntry } from "../types.ts";

type List = { entries: BodyweightEntry[]; latest: BodyweightEntry | null; change_kg: number | null };

export function Body({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const [data, setData] = useState<List | null>(null);
  const [weight, setWeight] = useState("");
  const [date, setDate] = useState(todayIso());
  const [msg, setMsg] = useState<string | null>(null);
  // Save reads the fields directly: a tap on Save can arrive before the last keystroke re-renders.
  const weightRef = useRef(weight);
  weightRef.current = weight;
  const dateRef = useRef<HTMLInputElement>(null);

  const load = () =>
    api<List>("GET", "/api/bodyweight?limit=30").then((d) => {
      setData(d);
      if (!weightRef.current && d.latest?.weight_kg) setWeight(String(d.latest.weight_kg));
    });
  useEffect(() => void load(), []);

  const save = async () => {
    const w = Number(weightRef.current);
    const day = dateRef.current?.value || date;
    if (!w) return setMsg(COPY.log.enter("your weight"));
    try {
      await api("PUT", `/api/bodyweight/${day}`, { weight_kg: w });
      setMsg(`${COPY.body.saved(w)} · ${dayLabel(day)}`);
      void load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const points = (data?.entries ?? [])
    .filter((e) => e.weight_kg != null)
    .map((e) => ({ date: e.date, value: e.weight_kg! }))
    .reverse();

  return (
    <section class="page enter">
      <h1>{COPY.body.title}</h1>
      {data?.latest?.weight_kg != null && (
        <div class="card m-nolift">
          <div class="body-now">
            <b class="num">{data.latest.weight_kg}</b>
            <span class="muted">kg · {dayLabel(data.latest.date)}</span>
          </div>
          {data.change_kg != null && (
            <p class="muted small">
              {data.change_kg > 0 ? "+" : ""}
              {data.change_kg} kg over the last {data.entries.length} entries
            </p>
          )}
          {points.length >= 2 && <Trend points={points} unit="kg" label="Bodyweight" spark />}
        </div>
      )}
      <div class="card m-nolift" style={{ display: "grid", gap: "var(--s-3)" }}>
        <div class="form-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div class="field">
            <span class="label">Weight</span>
            <Stepper value={weight} step={0.1} unit="kg" label="Weight in kg" decimal onInput={setWeight} />
          </div>
          <label class="field">
            Date
            <input ref={dateRef} type="date" value={date} max={todayIso()} onInput={(e) => setDate((e.target as HTMLInputElement).value)} />
          </label>
        </div>
        <button class="btn btn--primary btn--block" onClick={save}>
          {COPY.body.save}
        </button>
        {msg && (
          <p class="note" role="status">
            {msg}
          </p>
        )}
      </div>
      {data && data.entries.length > 0 && (
        <div class="card m-nolift">
          <ul class="row-list">
            {data.entries.map((e) => (
              <li class="kv">
                <span>{dayLabel(e.date)}</span>
                <span class="num">{e.weight_kg != null ? `${e.weight_kg} kg` : "—"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div class="kv">
        <span class="muted small">
          {COPY.body.signedIn} {email}
        </span>
        <button class="btn btn--secondary" onClick={onSignOut}>
          <Icon name="logOut" size={16} /> {COPY.body.signOut}
        </button>
      </div>
    </section>
  );
}
