/**
 * Interface glyphs from the pinned Lucide set (fetched by taste-skill icons.mjs into src/icons,
 * credits in icons-credits.json). Inlined at build time, so nothing loads an icon at runtime.
 */
import check from "../icons/ui-check.svg?raw";
import chevronLeft from "../icons/ui-chevron-left.svg?raw";
import chevronRight from "../icons/ui-chevron-right.svg?raw";
import cloudOff from "../icons/ui-cloud-off.svg?raw";
import dumbbell from "../icons/ui-dumbbell.svg?raw";
import ellipsis from "../icons/ui-ellipsis.svg?raw";
import history from "../icons/ui-history.svg?raw";
import logOut from "../icons/ui-log-out.svg?raw";
import minus from "../icons/ui-minus.svg?raw";
import notebook from "../icons/ui-notebook-text.svg?raw";
import play from "../icons/ui-play.svg?raw";
import plus from "../icons/ui-plus.svg?raw";
import scale from "../icons/ui-scale.svg?raw";
import timer from "../icons/ui-timer.svg?raw";
import trophy from "../icons/ui-trophy.svg?raw";
import x from "../icons/ui-x.svg?raw";

const ICONS = { check, chevronLeft, chevronRight, cloudOff, dumbbell, ellipsis, history, logOut, minus, notebook, play, plus, scale, timer, trophy, x };
export type IconName = keyof typeof ICONS;

/** Decorative by default (aria-hidden); pass `label` when the icon is the only content of a control. */
export function Icon({ name, size = 20, label }: { name: IconName; size?: number; label?: string }) {
  const a11y = label ? `role="img" aria-label="${label.replace(/"/g, "&quot;")}"` : 'aria-hidden="true" focusable="false"';
  const svg = ICONS[name]
    .replace(/\s(width|height|class|role|aria-label)="[^"]*"/g, "")
    .replace("<svg", `<svg class="icon" width="${size}" height="${size}" ${a11y}`);
  return <span class="icon-wrap" dangerouslySetInnerHTML={{ __html: svg }} />;
}
