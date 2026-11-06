// The keyboard of the window follows the focus ring (docs/spec/exposure.md#keyboard-focus): while no modal is open and no editable
// element of the workbench has the focus, the active surface of the card with the ring holds the keyboard. The plane moves the ring
// in one function, which owes the keyboard here. The one host call surfaceFocus goes out at once for a surface that a placement
// gave the host, so the host gives it the keyboard at the release of the press that moved the ring, before a key that follows the
// release; a surface that the host does not hold yet receives the keyboard after the placement that shows it, when it stands.
// A placement ends when the host answered the keyboard call that follows it, so a command, which answers after the placement,
// answers after the keyboard reached its target (docs/spec/exposure.md#the-keyboard-follows-the-focus-ring).
// The host holds the input of the window from the release of a press on the workbench until a call that carries decided, so each
// release of a left press in this document owes one decided call, sent after the handlers of the press ran, also for the same
// target or for the workbench.
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
/* The last keyboard call, fulfilled when the host answered it. */
let flight = Promise.resolve();
/*
 * A press released on the workbench waits for the call, which carries decided and ends the hold of the input of the window. It is
 * due once the handlers of the release ran, so no call of a handler ends the hold before the state that the press leaves.
 */
let due = false;

const editable = (element) => element !== null && element.matches("input, textarea, select, [contenteditable]");

/** The surface that holds the keyboard, or null when the workbench holds it. */
function target() {
  if (editable(document.activeElement)) return null;
  return ringSurface();
}

function send(surface) {
  if (surface === sent && !owed) return;
  const ends = due;
  owed = false;
  due = false;
  sent = surface;
  // An element that kept the focus would still show as focused beside the surface that holds the keyboard.
  if (surface !== null) document.activeElement?.blur();
  flight = Promise.resolve(surfaces.focus(surface, ends)).catch((why) => report(`surface focus: ${why}`));
}

/** Records one decision of the keyboard, the call it sent or why it sent none (docs/spec/exposure.md#the-keyboard-follows-the-focus-ring). */
function record(cause, surface, decision) {
  emitEvent("debug", "workbench.keyboard.follow", { cause, target: surface, sent, owed, decided: due, decision });
}

/** An open modal keeps the keyboard, so a press that waits for its decision ends the hold without a move of the keyboard. */
function keepInModal() {
  if (!due) return;
  due = false;
  Promise.resolve(surfaces.keyboardDecided()).catch((why) => report(`keyboard decided: ${why}`));
}

/** Sends the call when the host holds the target. A target that no placement placed yet waits for the placement. */
function follow(cause) {
  if (modalState() !== null) {
    owed = true;
    record(cause, null, "modal");
    keepInModal();
    return;
  }
  const surface = target();
  if (surface !== null && !shown.has(surface) && !held.has(surface)) {
    record(cause, surface, "wait");
    return;
  }
  record(cause, surface, surface === sent && !owed ? "same" : "send");
  send(surface);
}

/** Registers the function that reads the active surface of the card with the ring, null without one. */
export function followRing(read) {
  ringSurface = read;
  // The close of a modal changes the state before it queues its host call, and this call follows that one.
  onModalState(() => queueMicrotask(() => follow("modal")));
  document.addEventListener("focusin", () => follow("focusin"));
  document.addEventListener("focusout", () => queueMicrotask(() => follow("focusout")));
  // The listener of the capture phase sees every release of the document, whatever element takes it or captures the pointer.
  document.addEventListener("pointerup", (event) => { if (event.button === 0) keyboardPressed(); }, true);
}

/**
 * A left press of the workbench was released: the decided call follows the state that the handlers of the press leave. A browser
 * runs the microtasks between the listeners of one event and dispatches the click of the release in the same task, so the call
 * waits for the next task, after the last handler of the release.
 */
export function keyboardPressed() {
  setTimeout(() => {
    owed = true;
    due = true;
    follow("press");
  }, 0);
}

/** The ring moved, so the keyboard moves even to the target that it had. It follows the state that the move leaves. */
export function keyboardOwed() {
  owed = true;
  queueMicrotask(() => follow("ring"));
}

/**
 * A drawn placement answered with the surfaces it shows and the surfaces it placed. The ring on a surface that it does not show
 * leaves the keyboard with the workbench. Returns a promise that is fulfilled when the host answered the last keyboard call,
 * which the placement ends with.
 */
export function keyboardPlaced(ids, placedIds) {
  shown = new Set(ids);
  held = new Set(placedIds);
  if (modalState() !== null) {
    owed = true;
    record("placed", null, "modal");
    keepInModal();
    return flight;
  }
  const surface = target();
  const chosen = surface !== null && shown.has(surface) ? surface : null;
  record("placed", chosen, chosen === sent && !owed ? "same" : "send");
  send(chosen);
  return flight;
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
