// The error lines of the settings tab. Each line goes through the one error display path (shown-errors.js), and the tab keeps the lines it
// shows so that the status core.settings-tab reports them as {key, text}.
import { hideError, showError } from "./shown-errors.js";

/** The lines shown by the tab, by their place key. */
const shown = new Map();

/** Shows the error text of the place where through the error display path. */
export function showTabError(where, text) {
  showError(document, where, text);
  shown.set(where, text);
}

/** Withdraws the error of the place where. */
export function hideTabError(where) {
  hideError(document, where);
  shown.delete(where);
}

/** The lines that the tab shows, as {key, text}. */
export const tabErrors = () => [...shown].map(([key, text]) => ({ key, text }));
