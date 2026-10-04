// native surface lifecycle을 카드 상태 행에 계속 보이게 한다.
import { hideError, showError } from "./shown-errors.js";
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

  // 표면 오류는 상태 행에 보이는 순간 로그에도 남긴다. 다음 상태가 그 표시를 지운다.
  // 기본값: 카드에 속하지 않은 상태 행은 자리 이름 없이 적는다.
  const card = status.closest("[data-card-id]");
  // 같은 card id 를 여러 프로젝트가 쓰므로 표면 id 도 적는다.
  // 기본값: 카드에 속하지 않은 상태 행이나 표면 자리가 없는 카드는 그 이름 없이 적는다.
  const surface = card?.querySelector("[data-native-surface-id]")?.dataset.nativeSurfaceId ?? "without a surface";
  // 기본값: 카드에 속하지 않은 상태 행은 카드 이름 없이 적는다.
  const where = `surface status ${card?.dataset.cardId ?? "outside a card"} ${surface}`;
  if (phase === "error") {
    showError(indicator, where, `표면 오류 · ${surfaceErrorText(state)}`);
    return;
  }
  hideError(indicator, where);
  indicator.textContent = phase === "loading" ? "불러오는 중" : "";
}
