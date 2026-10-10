// Keeps the native surface lifecycle visible in the card status row.
import { hideError, showError } from "./shown-errors.js";
/** The description of the error state. An error state must have an error. */
export function surfaceErrorText(state) {
  if (state.error === null || state.error === undefined) throw new Error("a surface error state carries no error");
  return state.error instanceof Error ? state.error.message : String(state.error);
}

export function setSurfaceStatus(status, state) {
  if (!status) return;
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
  // default: a status row that does not belong to a card, or a card without a surface place, is written without that name.
  const surface = card?.querySelector("[data-native-surface-id]")?.dataset.nativeSurfaceId ?? "without a surface";
  // default: a status row that does not belong to a card is written without a card name.
  const where = `surface status ${card?.dataset.cardId ?? "outside a card"} ${surface}`;
  if (phase === "error") {
    showError(indicator, where, `표면 오류 · ${surfaceErrorText(state)}`);
    return;
  }
  hideError(indicator, where);
  indicator.textContent = phase === "loading" ? "불러오는 중" : "";
}
