// Keeps the native surface lifecycle visible in the card status row.
import { hideError, showError } from "./shown-errors.js";
/** The description of the error state. An error state must have an error. */
export function surfaceErrorText(state) {
  if (state.error === null || state.error === undefined) throw new Error("a surface error state carries no error");
  return state.error instanceof Error ? state.error.message : String(state.error);
}

/** Shows the state of the surface `surface` (its tab id) in the card status row `status`. */
export function setSurfaceStatus(status, surface, state) {
  if (!status) return;
  if (typeof surface !== "string" || surface === "") throw new TypeError(`a surface status needs a surface id, not ${surface}`);
  let indicator = status.querySelector("[data-surface-status]");
  if (!indicator) {
    indicator = document.createElement("span");
    indicator.className = "surface-status";
    indicator.dataset.surfaceStatus = "loading";
    indicator.setAttribute("aria-live", "polite");
    status.prepend(indicator);
  }
  const { phase } = state;
  if (!["loading", "ready", "error"].includes(phase)) throw new Error(`invalid surface phase: ${phase}`);
  status.dataset.surfaceStatus = phase;
  status.setAttribute("aria-busy", String(phase === "loading"));
  indicator.dataset.surfaceStatus = phase;
  indicator.hidden = phase === "ready";

  // A surface error is also written to the log at the moment it is shown in the status row. The next state erases that display.
  // default: a status row that does not belong to a card is written without a place name.
  const card = status.closest("[data-card-id]");
  // Several projects use the same card id, so the surface id is written too.
  // default: a status row that does not belong to a card is written without a card name.
  const where = `surface status ${card?.dataset.cardId ?? "outside a card"} ${surface}`;
  if (phase === "error") {
    const text = `표면 오류 · ${surfaceErrorText(state)}`;
    showError(indicator, where, text);
    // The row cuts the text with an ellipsis, so the tooltip holds the whole text.
    indicator.title = text;
    return;
  }
  hideError(indicator, where);
  indicator.removeAttribute("title");
  indicator.textContent = phase === "loading" ? "불러오는 중" : "";
}

/**
 * Shows the operation error `text` of the active tab `tab` in the card status row `status`, or withdraws it for null
 * (docs/spec/plugins.md#tab-reports). The row cuts the text with an ellipsis, so the tooltip holds the whole text.
 */
export function setTabError(status, tab, text) {
  let line = status.querySelector(".status__error");
  if (!line) {
    line = document.createElement("span");
    line.className = "status__error";
    status.appendChild(line);
  }
  const where = `tab error ${tab}`;
  if (text !== null) {
    showError(line, where, text);
    line.title = text;
    return;
  }
  line.hidden = true;
  line.removeAttribute("title");
  hideError(line, where);
}
