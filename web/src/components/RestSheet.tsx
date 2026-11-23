import { useEffect, useRef, useState } from "preact/hooks";
import { COPY } from "../copy.ts";
import { adjustRest, formatClock, remainingS, type RestTimer } from "../lib/timer.ts";
import { Icon } from "./Icon.tsx";

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

const R = 58;
const C = 2 * Math.PI * R;

/**
 * The rest timer: a ring readable at arm's length with what's next, collapsing to a slim bar while
 * you edit or scroll. Worked out from an end timestamp, so it survives sleeps and reloads.
 */
export function RestSheet(props: { timer: RestTimer; collapsed: boolean; onExpand: () => void; onChange: (t: RestTimer | null) => void }) {
  const { timer } = props;
  const [now, setNow] = useState(Date.now());
  const alerted = useRef(false);

  useEffect(() => {
    alerted.current = remainingS(timer, Date.now()) === 0;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [timer]);

  const left = remainingS(timer, now);
  const over = left === 0;
  useEffect(() => {
    if (!over) return;
    // Alert once when it reaches zero (not again after a reload), then fold away either way.
    if (!alerted.current) {
      alerted.current = true;
      beep();
      navigator.vibrate?.([200, 100, 200]);
    }
    const hide = setTimeout(() => props.onChange(null), 5000);
    return () => clearTimeout(hide);
  }, [over]);

  const frac = Math.min(1, Math.max(0, left / timer.total));
  const time = over ? COPY.log.restOver : formatClock(left);

  if (props.collapsed) {
    return (
      <div class={`rest ${over ? "is-over" : ""}`} role="timer" aria-live="polite">
        <button class="rest__bar" onClick={props.onExpand} aria-label={`Rest ${time}. Show timer`}>
          <span class="rest__bar-fill" style={{ width: `${frac * 100}%` }} />
          <Icon name="timer" size={18} />
          <span class="num">{time}</span>
          <span class="muted small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {COPY.log.next}: {timer.label}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div class={`rest ${over ? "is-over" : ""}`} role="timer" aria-live="polite">
      <div class="rest__card">
        <div class="rest__big">
          <div class="ring">
            <svg width="132" height="132" viewBox="0 0 132 132" aria-hidden="true">
              <circle class="ring__track" cx="66" cy="66" r={R} fill="none" stroke-width="10" />
              <circle class="ring__bar" cx="66" cy="66" r={R} fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray={C} stroke-dashoffset={C * (1 - frac)} />
            </svg>
            <span class="ring__time">{over ? "0:00" : formatClock(left)}</span>
          </div>
          <div class="rest__next">
            <span class="label">{over ? COPY.log.restOver : COPY.log.next}</span>
            <b>{timer.label}</b>
          </div>
        </div>
        <div class="rest__actions">
          <button class="btn btn--secondary" onClick={() => props.onChange(adjustRest(timer, -15, Date.now()))}>
            −15s
          </button>
          <button class="btn btn--secondary" onClick={() => props.onChange(adjustRest(timer, 15, Date.now()))}>
            +15s
          </button>
          <button class="btn btn--secondary" onClick={() => props.onChange(null)}>
            {COPY.log.skip}
          </button>
        </div>
      </div>
    </div>
  );
}
