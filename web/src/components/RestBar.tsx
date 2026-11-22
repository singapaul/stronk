import { useEffect, useRef, useState } from "preact/hooks";
import { adjustRest, formatClock, remainingS, type RestTimer } from "../lib/timer.ts";

/** Short beep through Web Audio (no audio file to load). */
function beep() {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
  } catch {
    /* audio unavailable */
  }
}

export function RestBar({ timer, onChange }: { timer: RestTimer; onChange: (t: RestTimer | null) => void }) {
  const [now, setNow] = useState(Date.now());
  const alerted = useRef(false);

  useEffect(() => {
    alerted.current = remainingS(timer, Date.now()) === 0;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [timer]);

  const left = remainingS(timer, now);
  useEffect(() => {
    if (left === 0 && !alerted.current) {
      alerted.current = true;
      beep();
      navigator.vibrate?.([200, 100, 200]);
      const hide = setTimeout(() => onChange(null), 4000);
      return () => clearTimeout(hide);
    }
  }, [left]);

  const pct = Math.min(100, Math.max(0, (left / timer.total) * 100));
  return (
    <div class={`restbar ${left === 0 ? "over" : ""}`} role="timer" aria-live="polite">
      <div class="restbar-fill" style={{ width: `${pct}%` }} />
      <div class="restbar-body">
        <div>
          <div class="restbar-time">{left === 0 ? "Rest over" : formatClock(left)}</div>
          <div class="muted small">{timer.label}</div>
        </div>
        <div class="restbar-actions">
          <button onClick={() => onChange(adjustRest(timer, -15, Date.now()))}>−15</button>
          <button onClick={() => onChange(adjustRest(timer, 15, Date.now()))}>+15</button>
          <button onClick={() => onChange(null)}>Skip</button>
        </div>
      </div>
    </div>
  );
}
