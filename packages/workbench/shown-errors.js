// The only path that shows an error to the user. The next drawing or reload erases the error display on the screen, so the record written to the application
// log at the moment it is shown is the trace of that error (AGENTS.md, docs/spec/hosts.md#application-log). The error color is used only for the
// `data-error` element that this path attaches. Drawing the same error again at the same place does not write it again.
import { report } from "./host.js";

const shown = new Map();

/**
 * Shows the error text of the place where on the element element, and writes `error: <where>: <text><detail>` only when the error of that place changed.
 * detail is a detail (the location or stack of the error) that is not shown on the screen and is kept only in the log.
 */
export function showError(element, where, text, detail = "") {
  element.textContent = text;
  element.dataset.error = where;
  element.hidden = false;
  if (shown.get(where) === text) return;
  shown.set(where, text);
  report(`${where}: ${text}${detail}`);
}

/** Withdraws the error display of the place where. A place that is not drawn, with no element, can be withdrawn too. If the same error is shown next time, it is written again. */
export function hideError(element, where) {
  if (element) delete element.dataset.error;
  shown.delete(where);
}
