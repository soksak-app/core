// Manages the display and the command bindings of the card header tools.
import { bind } from "./commands.js";
import { declaredIcons as icons } from "./icons.js";
import declaration from "./workbench.json" with { type: "json" };

/** The names of the card tools and the reasons of their refusals, declared in workbench.json for both workbenches (docs/spec/example-model.md#card-tools). */
const names = declaration.cardTools;

export const CARD_TOOL_MENUS = { add: "add", x: "split-x", y: "split-y" };
const definitions = [
  ["add", names.add, "core.card.add", icons["card-add"]],
  ["x", names["split-x"], "core.card.split-x", icons["card-split-x"]],
  ["y", names["split-y"], "core.card.split-y", icons["card-split-y"]],
  ["fullscreen", names.fullscreen, "core.card.fullscreen", icons["card-expand"]],
  ["close", names.close, "core.card.close", icons["card-close"]],
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
    let title = fullscreen && layout ? names["layout-held"]
      : disabled && action === "close" ? names["close-refused"] : button.dataset.title;
    if (action === "fullscreen") {
      title = fullscreen ? names.restore : names.fullscreen;
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
