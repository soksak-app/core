// The keyboard of the window follows the focus ring (docs/spec/exposure.md#keyboard-focus): while no modal is open and no editable
// element of the workbench has the focus, the active surface of the card with the ring holds the keyboard. The plane moves the ring
// in one function, which owes the keyboard here. The one host call surfaceFocus follows the placement that shows the surface, so a
// surface that the host does not hold yet receives the keyboard when it stands.
import { modalState, onModalState, report, surfaces } from "./host.js";

/* The surface of the ring, which the plane registers. */
let ringSurface = () => null;
/* The surfaces that the last drawn placement shows. */
let shown = new Set();
/* owed: the keyboard has to move even when the target is the same. sent: the target of the last call, null for the workbench. */
let owed = false;
let sent = null;

const editable = (element) => element?.matches?.("input, textarea, select, [contenteditable]") ?? false;

/** The surface that holds the keyboard, or null when the workbench holds it. */
function target() {
  if (editable(document.activeElement)) return null;
  return ringSurface();
}

function send(surface) {
  if (surface === sent && !owed) return;
  owed = false;
  sent = surface;
  // An element that kept the focus would still show as focused beside the surface that holds the keyboard.
  if (surface !== null) document.activeElement?.blur?.();
  Promise.resolve(surfaces.focus(surface)).catch((why) => report(`surface focus: ${why}`));
}

/** Sends the call when the target stands. A target that no placement showed yet waits for the placement. */
function follow() {
  if (modalState() !== null) {
    owed = true;
    return;
  }
  const surface = target();
  if (surface === null || shown.has(surface)) send(surface);
}

/** Registers the function that reads the active surface of the card with the ring, null without one. */
export function followRing(read) {
  ringSurface = read;
  // The close of a modal changes the state before it queues its host call, and this call follows that one.
  onModalState(() => queueMicrotask(follow));
  document.addEventListener("focusin", follow);
  document.addEventListener("focusout", () => queueMicrotask(follow));
}

/** The ring moved, so the keyboard moves even to the target that it had. It follows the state that the move leaves. */
export function keyboardOwed() {
  owed = true;
  queueMicrotask(follow);
}

/** A drawn placement answered with the surfaces it shows. The ring on a surface that it does not show leaves the keyboard with the workbench. */
export function keyboardPlaced(ids) {
  shown = new Set(ids);
  if (modalState() !== null) {
    owed = true;
    return;
  }
  const surface = target();
  send(surface !== null && shown.has(surface) ? surface : null);
}

/**
 * The first responder of the window reached the workbench while a surface should hold the keyboard: a press on the workbench, or
 * AppKit moving it from a view that it hides or closes. An element that holds the focus keeps it, as the Tab key left it.
 */
export function keyboardResponder({ owner }) {
  if (owner !== "workbench" || (document.activeElement && document.activeElement !== document.body)) return;
  owed = true;
  follow();
}
