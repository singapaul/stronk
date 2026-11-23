import { Icon } from "./Icon.tsx";

/** A bottom sheet with a title and a close button; closes on the backdrop. */
export function Sheet(props: { title: string; onClose: () => void; children: preact.ComponentChildren }) {
  return (
    <div class="sheet-backdrop" onClick={props.onClose}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={props.title} onClick={(e) => e.stopPropagation()}>
        <div class="sheet__head">
          <h2 class="grow">{props.title}</h2>
          <button class="icon-btn" onClick={props.onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}
