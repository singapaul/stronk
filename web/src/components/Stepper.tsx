import { useId } from "preact/hooks";
import { Icon } from "./Icon.tsx";

/**
 * A number field with −/+ buttons. The unit is the field's visible label, set inside the box, so
 * every control in a set row is the same height and every field has a label you can see.
 */
export function Stepper(props: {
  value: string;
  step: number;
  unit: string;
  label: string;
  decimal?: boolean;
  disabled?: boolean;
  min?: number;
  onInput: (v: string) => void;
  onCommit?: () => void;
  wide?: boolean;
}) {
  const id = useId();
  const bump = (dir: 1 | -1) => {
    const cur = Number(props.value || 0);
    const next = Math.max(props.min ?? -Infinity, Math.round((cur + dir * props.step) * 100) / 100);
    props.onInput(String(next));
    props.onCommit?.();
  };
  return (
    <div class={`stepper ${props.wide ? "stepper--wide" : ""}`}>
      <button type="button" disabled={props.disabled} onClick={() => bump(-1)} aria-label={`${props.label}: minus ${props.step}`}>
        <Icon name="minus" size={18} />
      </button>
      <div class="stepper__field">
        <input
          id={id}
          inputMode={props.decimal ? "decimal" : "numeric"}
          value={props.value}
          disabled={props.disabled}
          aria-label={props.label}
          onInput={(e) => props.onInput((e.target as HTMLInputElement).value)}
          onBlur={() => props.onCommit?.()}
        />
        <label class="stepper__unit" for={id}>
          {props.unit}
        </label>
      </div>
      <button type="button" disabled={props.disabled} onClick={() => bump(1)} aria-label={`${props.label}: plus ${props.step}`}>
        <Icon name="plus" size={18} />
      </button>
    </div>
  );
}
