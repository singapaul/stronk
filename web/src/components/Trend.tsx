import { plot, type Point } from "../lib/trend.ts";

/**
 * A small SVG line chart: y-axis ticks, the line over a soft accent area, a dot per point and the
 * best point filled. `spark` drops the axis for an inline sparkline.
 */
export function Trend(props: { points: Point[]; unit: string; label: string; spark?: boolean; height?: number }) {
  const W = 340;
  const H = props.height ?? (props.spark ? 64 : 180);
  const pad = props.spark ? { t: 6, r: 6, b: 6, l: 6 } : { t: 12, r: 12, b: 12, l: 40 };
  const p = plot(props.points, W, H, pad);
  if (!p.d) return null;
  const best = Math.max(...props.points.map((x) => x.value));
  const last = p.dots[p.dots.length - 1]!;
  const area = `${p.d} L${last.x.toFixed(1)} ${H - pad.b} L${p.dots[0]!.x.toFixed(1)} ${H - pad.b} Z`;
  const summary = `${props.label}: ${props.points.map((x) => `${x.value} ${props.unit}`).join(", ")}`;
  return (
    <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary}>
      {!props.spark &&
        p.ticks.map((t) => (
          <g>
            <line class="chart__grid" x1={pad.l} x2={W - pad.r} y1={t.y} y2={t.y} />
            <text class="chart__tick" x={pad.l - 6} y={t.y + 4} text-anchor="end">
              {t.value}
            </text>
          </g>
        ))}
      <path class="chart__area" d={area} />
      <path class="chart__line" d={p.d} />
      {!props.spark && p.dots.map((d) => <circle class={`chart__dot ${d.value === best ? "is-best" : ""}`} cx={d.x} cy={d.y} r={4.5} />)}
      {props.spark && <circle class="chart__dot is-best" cx={last.x} cy={last.y} r={4} />}
    </svg>
  );
}
