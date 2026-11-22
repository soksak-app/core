// Keeps the native surface lifecycle visible in the card status row.
import { mark } from "./commands.js";
import { hideError, showError } from "./shown-errors.js";
import { onTabsClosed } from "./closed-tabs.js";

// The place of the shown error of each stopped surface by its tab id, which the close of the tab withdraws.
const surfaceErrorPlaces = new Map();
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
  // The control runs core.tab.reload of the tab, and it exists only while the surface shows its error.
  status.querySelector("[data-surface-reload]")?.remove();
  if (phase === "error") {
    // The status row keeps a state label; the error text shows in the error toast.
    indicator.textContent = "표면 오류";
    indicator.removeAttribute("title");
    showError(document, where, `표면 오류 · ${surfaceErrorText(state)}`);
    surfaceErrorPlaces.set(surface, where);
    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "surface-status__reload";
    reload.dataset.surfaceReload = surface;
    reload.dataset.expose = "core.tab.reload";
    reload.textContent = "다시 불러오기";
    mark(reload, "core.tab.reload", { tab: surface });
    status.append(reload);
    return;
  }
  hideError(document, where);
  surfaceErrorPlaces.delete(surface);
  indicator.removeAttribute("title");
  indicator.textContent = phase === "loading" ? "불러오는 중" : "";
}

/**
 * Shows the operation error `text` of the active tab `tab` in the error toast, or withdraws it for null
 * (docs/spec/plugins.md#tab-reports).
 */
export function setTabError(tab, text) {
  const where = `tab error ${tab}`;
  if (text !== null) showError(document, where, text);
  else hideError(document, where);
}

// The close of a tab withdraws its operation error and the error of its stopped surface: the state that each describes ended with the
// tab, and a display shows only the current state (docs/spec/exposure.md#error-presentation).
onTabsClosed((ids) => {
  for (const id of ids) {
    hideError(document, `tab error ${id}`);
    const where = surfaceErrorPlaces.get(id);
    if (where === undefined) continue;
    surfaceErrorPlaces.delete(id);
    hideError(document, where);
  }
});
