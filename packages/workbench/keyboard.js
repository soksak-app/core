// The keyboard of the window follows the focus ring (docs/spec/exposure.md#keyboard-focus): while no modal is open and no editable
// element of the workbench has the focus, the active surface of the card with the ring holds the keyboard. The plane moves the ring
// in one function, which owes the keyboard here. The one host call surfaceFocus goes out at once for a surface that a placement
// gave the host, so the host gives it the keyboard at the release of the press that moved the ring, before a key that follows the
// release; a surface that the host does not hold yet receives the keyboard after the placement that shows it, when it stands.
import { modalState, onModalState, report, surfaces } from "./host.js";
import { emitEvent } from "./page-log.js";

/* The surface of the ring, which the plane registers. */
let ringSurface = () => null;
/* The surfaces that the last drawn placement shows, and held all that it placed, shown or hidden, which the host holds. */
let shown = new Set();
let held = new Set();
/* owed: the keyboard has to move even when the target is the same. sent: the target of the last call, null for the workbench. */
let owed = false;
let sent = null;

const editable = (element) => element !== null && element.matches("input, textarea, select, [contenteditable]");

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
  if (surface !== null) document.activeElement?.blur();
  Promise.resolve(surfaces.focus(surface)).catch((why) => report(`surface focus: ${why}`));
}

/** Records one decision of the keyboard, the call it sent or why it sent none (docs/spec/exposure.md#the-keyboard-follows-the-focus-ring). */
function decided(cause, surface, decision) {
  emitEvent("debug", "workbench.keyboard.follow", { cause, target: surface, sent, owed, decision });
}

/** Sends the call when the host holds the target. A target that no placement placed yet waits for the placement. */
function follow(cause) {
  if (modalState() !== null) {
    owed = true;
    decided(cause, null, "modal");
    return;
  }
  const surface = target();
  if (surface !== null && !shown.has(surface) && !held.has(surface)) {
    decided(cause, surface, "wait");
    return;
  }
  decided(cause, surface, surface === sent && !owed ? "same" : "send");
  send(surface);
}

/** Registers the function that reads the active surface of the card with the ring, null without one. */
export function followRing(read) {
  ringSurface = read;
  // The close of a modal changes the state before it queues its host call, and this call follows that one.
  onModalState(() => queueMicrotask(() => follow("modal")));
  document.addEventListener("focusin", () => follow("focusin"));
  document.addEventListener("focusout", () => queueMicrotask(() => follow("focusout")));
}

/** The ring moved, so the keyboard moves even to the target that it had. It follows the state that the move leaves. */
export function keyboardOwed() {
  owed = true;
  queueMicrotask(() => follow("ring"));
}

/**
 * A drawn placement answered with the surfaces it shows and the surfaces it placed. The ring on a surface that it does not show
 * leaves the keyboard with the workbench.
 */
export function keyboardPlaced(ids, placedIds) {
  shown = new Set(ids);
  held = new Set(placedIds);
  if (modalState() !== null) {
    owed = true;
    decided("placed", null, "modal");
    return;
  }
  const surface = target();
  const chosen = surface !== null && shown.has(surface) ? surface : null;
  decided("placed", chosen, chosen === sent && !owed ? "same" : "send");
  send(chosen);
}

/**
 * The first responder of the window reached the workbench while a surface should hold the keyboard: a press on the workbench, or
 * AppKit moving it from a view that it hides or closes. An element that holds the focus keeps it, as the Tab key left it.
 */
export function keyboardResponder({ owner }) {
  if (owner !== "workbench" || (document.activeElement && document.activeElement !== document.body)) return;
  owed = true;
  follow("responder");
}
