// Manages the display and the command bindings of the card header tools.
import { bind } from "./commands.js";
import { declaredIcons as icons } from "./icons.js";

export const CARD_TOOL_MENUS = { add: "add", x: "split-x", y: "split-y" };
const definitions = [
  ["add", "이 카드에 탭 추가 — 무엇을 띄울지 묻는다", "core.card.add", icons["card-add"]],
  ["x", "세로선으로 쪼개기 — 좌우로 나뉜다", "core.card.split-x", icons["card-split-x"]],
  ["y", "가로선으로 쪼개기 — 위아래로 나뉜다", "core.card.split-y", icons["card-split-y"]],
  ["fullscreen", "카드 전체 화면", "core.card.fullscreen", icons["card-expand"]],
  ["close", "이 카드를 닫는다 — 안의 탭이 몇 개든 함께 간다", "core.card.close", icons["card-close"]],
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
    // A fullscreen card does not change the layout, so adding a tab, splitting and closing wait for the restore.
    const layout = action === "add" || action === "x" || action === "y" || action === "close";
    const disabled = fullscreen && layout ? true
      : action === "close" ? !canClose : action === "x" ? !canSplitX : action === "y" ? !canSplitY : false;
    if (button.disabled !== disabled) button.disabled = disabled;
    let title = fullscreen && layout ? "전체 화면에서는 배치를 바꾸지 않는다 — 먼저 카드 배치를 복원한다"
      : disabled && action === "close" ? "닫을 수 없다 — 어느 이웃도 이 위치를 빈틈없이 못 메운다" : button.dataset.title;
    if (action === "fullscreen") {
      title = fullscreen ? "카드 배치 복원" : "카드 전체 화면";
      const pressed = String(fullscreen);
      if (button.getAttribute("aria-pressed") !== pressed) {
        button.innerHTML = icon(icons[fullscreen ? "card-restore" : "card-expand"]);
        button.setAttribute("aria-pressed", pressed);
      }
    }
    if (button.title !== title) button.title = title;
    if (button.getAttribute("aria-label") !== title) button.setAttribute("aria-label", title);
  }
}
