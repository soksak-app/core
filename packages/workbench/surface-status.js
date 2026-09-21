// Keeps the native surface lifecycle visible in the card status row.
export function setSurfaceStatus(status, state = {}) {
  if (!status) return;
  let indicator = status.querySelector("[data-surface-status]");
  if (!indicator) {
    indicator = document.createElement("span");
    indicator.className = "surface-status";
    indicator.dataset.surfaceStatus = "loading";
    indicator.setAttribute("aria-live", "polite");
    status.prepend(indicator);
  }
  const phase = state.phase ?? "loading";
  status.dataset.surfaceStatus = phase;
  status.setAttribute("aria-busy", String(phase === "loading"));
  indicator.dataset.surfaceStatus = phase;
  indicator.hidden = phase === "ready";
  indicator.textContent = phase === "error"
    ? `표면 오류 · ${state.error?.message ?? state.error ?? "알 수 없는 오류"}`
    : phase === "loading" ? "불러오는 중" : "";
}
