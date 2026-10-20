// Input handling of a [data-native-modal] card. The main document and the overlay view use it together.
//
// A card has one copy in the main document and one in the native view. It is placed here
// because both documents must handle the same input.

/** The key of the answer of an Escape in a native menu. It is the declared command that closes the menu (docs/spec/exposure.md). */
export const MODAL_DISMISS = "core.modal.dismiss";

/**
 * Passes the (key, value) that a control inside root answered to send.
 *
 * A press has an empty value, and a value change carries that value. No listener is registered
 * for each control. The native view renders a copy of this element, so a listener registered
 * there does not work.
 */
export function onAnswer(root, send) {
  root.addEventListener("click", (e) => {
    const hit = e.target.closest("[data-key]");
    if (hit) send(hit.dataset.key, "");
  });
  root.addEventListener("change", (e) => {
    const el = e.target.closest("[data-set]");
    if (el) send(el.dataset.set, el.type === "checkbox" ? String(el.checked) : el.value);
  });
  // A menu is canceled with Escape. A dialog is closed only by its own close button.
  root.addEventListener("keydown", (e) => {
    const menu = '[data-native-modal="menu"]';
    if (e.key === "Escape" && root.querySelector(menu)) send(MODAL_DISMISS, "");
  });
}

/**
 * Dragging a [data-grip] inside root calls moved(dx, dy).
 *
 * The movement distance is computed as a difference of screen coordinates. The overlay view moves with the drag, so the
 * coordinates inside the view change reference every frame, and movementX is 0 for an event without an OS delta.
 * The owning document of the card decides the position.
 *
 * A button inside [data-grip] is excluded. A click on the close button must not become a drag.
 */
export function onGripDrag(root, moved) {
  root.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (!e.target.closest("[data-grip]") || e.target.closest("button")) return;
    e.preventDefault();
    let x = e.screenX;
    let y = e.screenY;
    const move = (ev) => {
      moved(ev.screenX - x, ev.screenY - y);
      x = ev.screenX;
      y = ev.screenY;
    };
    const up = () => {
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  });
}

/**
 * While a range input is dragged, updates the output text next to it.
 *
 * A settings change is reported only on change. Reporting on every input would redraw the card and
 * replace the element being dragged. This display is not reported and is updated only here.
 */
export function showValue(root) {
  root.addEventListener("input", (e) => {
    const el = e.target.closest("input[type=range][data-set]");
    if (!el) return;
    const out = el.parentElement.querySelector("output");
    if (out) out.textContent = out.textContent.replace(/^-?[\d.]+/, el.value);
  });
}
