// The undo toast of the settings tab (docs/spec/settings.md#saving-and-undo). A change of a setting shows its text with the button 되돌리기 for
// five seconds. The toast has no close control and it is not an error: it uses no error color and no error display path.
import { mark } from "./commands.js";
import { element } from "./settings-controls.js";

/** The time that the toast stays, in milliseconds (docs/spec/settings.md#saving-and-undo). */
export const UNDO_MS = 5000;

/** The toast in front, {text, command, params}, or null. A new toast replaces the one that is shown. */
let current = null;
let timer = null;
/** Calls fn when the toast of the tab changes. */
let changed = () => {};

/** Sets the function that redraws the foot of the tab when the toast changes. */
export function onUndoChange(fn) {
  changed = fn;
}

/**
 * Shows the toast with text; pressing its button runs command with params (the change with the old value). detail is the change as the
 * status reports it: {key, label, old, new}.
 */
export function showUndo(text, command, params, detail) {
  if (typeof text !== "string" || text === "") throw new Error("an undo toast needs its text");
  clearTimeout(timer);
  current = { text, command, params, detail };
  timer = setTimeout(() => dismissUndo(), UNDO_MS);
  changed();
}

/** Removes the toast and its deadline. */
export function dismissUndo() {
  clearTimeout(timer);
  timer = null;
  current = null;
  changed();
}

/** The text of the toast in front, or null. */
export const undoText = () => (current === null ? null : current.text);

/** The toast element of the foot, or null when no toast is shown. The button runs core.settings-tab.undo. */
export function undoElement() {
  if (current === null) return null;
  const el = element("div", "set-toast");
  el.setAttribute("role", "status");
  el.dataset.expose = "core.settings-tab.toast";
  el.append(element("span", "set-toast__text", current.text));
  const button = element("button", "ui-button set-button set-button--sm", "되돌리기");
  button.type = "button";
  button.dataset.expose = "core.settings-tab.undo";
  mark(button, "core.settings-tab.undo", {});
  el.append(button);
  return el;
}

/** The command and parameters that the button 되돌리기 runs, or null. */
export const undoAction = () => (current === null ? null : { command: current.command, params: current.params });

/** The toast of the status: {key, label, old, new}, or null. */
export const undoState = () => (current === null ? null : current.detail);
