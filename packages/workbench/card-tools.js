// 카드 머리 도구의 표시와 명령 바인딩을 관리한다.
import { bind } from "./commands.js";

export const CARD_TOOL_MENUS = { add: "add", x: "split-x", y: "split-y" };
const EXPAND = '<path d="M6 2H2v4M10 2h4v4M2 10v4h4M14 10v4h-4"/>';
const RESTORE = '<path d="M2 6h4V2M10 2v4h4M6 14v-4H2M14 10h-4v4"/>';
const definitions = [
  ["add", "이 카드에 탭 추가 — 무엇을 띄울지 묻는다", "core.card.add", '<path d="M8 3v10M3 8h10"/>'],
  ["x", "세로선으로 쪼개기 — 좌우로 나뉜다", "core.card.split-x", '<rect class="half" x="2" y="3" width="6" height="10" rx="1.5"/><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M8 3v10"/>'],
  ["y", "가로선으로 쪼개기 — 위아래로 나뉜다", "core.card.split-y", '<rect class="half" x="3" y="2" width="10" height="6" rx="1.5"/><rect x="3" y="2" width="10" height="12" rx="2"/><path d="M3 8h10"/>'],
  ["fullscreen", "카드 전체 화면", "core.card.fullscreen", EXPAND],
  ["close", "이 카드를 닫는다 — 안의 탭이 몇 개든 함께 간다", "core.card.close", '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'],
];
const icon = (path) => `<svg viewBox="0 0 16 16" aria-hidden="true">${path}</svg>`;

export function createCardTools(card) {
  const toolbar = document.createElement("span");
  toolbar.className = "chrome__acts";
  for (const [action, title, expose, svg] of definitions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chrome__act";
    button.dataset.do = action;
    button.dataset.expose = expose;
    button.dataset.title = title;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.innerHTML = icon(svg);
    const menu = CARD_TOOL_MENUS[action];
    if (menu) bind(button, "core.card.menu", { card, menu });
    else bind(button, expose, { card });
    toolbar.appendChild(button);
  }
  return toolbar;
}

export function updateCardTools(toolbar, { canClose, canSplitX, canSplitY, fullscreen }) {
  for (const button of toolbar.children) {
    const action = button.dataset.do;
    button.disabled = action === "close" ? !canClose : action === "x" ? !canSplitX : action === "y" ? !canSplitY : false;
    let title = button.disabled && action === "close"
      ? "닫을 수 없다 — 어느 이웃도 이 위치를 빈틈없이 못 메운다" : button.dataset.title;
    if (action === "fullscreen") {
      title = fullscreen ? "카드 배치 복원" : "카드 전체 화면";
      const pressed = String(fullscreen);
      if (button.getAttribute("aria-pressed") !== pressed) {
        button.innerHTML = icon(fullscreen ? RESTORE : EXPAND);
        button.setAttribute("aria-pressed", pressed);
      }
    }
    button.title = title;
    button.setAttribute("aria-label", title);
  }
}
