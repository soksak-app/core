// Keeps the native surface lifecycle visible in the card status row.
/** 오류 상태의 설명. 오류 상태는 오류를 가져야 한다. */
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
  indicator.textContent = phase === "error"
    ? `표면 오류 · ${surfaceErrorText(state)}`
    : phase === "loading" ? "불러오는 중" : "";
}
