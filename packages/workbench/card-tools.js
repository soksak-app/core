// Manages the display and the command bindings of the card header tools.
import { bind } from "./commands.js";
import { declaredIcons as icons } from "./icons.js";
import declaration from "./workbench.json" with { type: "json" };

/** The names of the card tools and the reasons of their refusals, declared in workbench.json for both workbenches (docs/spec/example-model.md#card-tools). */
const names = declaration.cardTools;

export const CARD_TOOL_MENUS = { add: "add", x: "split-x", y: "split-y", gx: "group-x", gy: "group-y" };
const definitions = [
  ["add", names.add, "core.card.add", icons["card-add"]],
  ["x", names["split-x"], "core.card.split-x", icons["card-split-x"]],
  ["y", names["split-y"], "core.card.split-y", icons["card-split-y"]],
  ["gx", names["group-x"], "core.card.group-x", icons["card-split-x"]],
  ["gy", names["group-y"], "core.card.group-y", icons["card-split-y"]],
  ["leader", names.leader, "core.card.leader", icons["card-leader"]],
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
    else if (action === "leader") bind(button, "core.group.leader", { card });
    else bind(button, expose, { card });
    toolbar.appendChild(button);
  }
  framePair(toolbar);
  return toolbar;
}

/**
 * Puts the group split buttons of the tool row toolbar into one frame, the rounded frame that encloses the pair with the padding
 * card-group-frame-pad (docs/spec/groups.md#headers).
 */
export function framePair(toolbar) {
  const gx = toolbar.querySelector(":scope > .chrome__act[data-do=gx]");
  const gy = toolbar.querySelector(":scope > .chrome__act[data-do=gy]");
  if (!gx || !gy) return;
  const frame = document.createElement("span");
  frame.className = "chrome__pair";
  gx.before(frame);
  frame.append(gx, gy);
}

/**
 * Draws the state of the card tools. The group split buttons are enabled while canGroupX and canGroupY, a group of the card toward right
 * and toward bottom, would succeed, as a split button is enabled while its split would succeed, and the leader button is shown while
 * leads, a level of two or more members, holds the card; it is pressed on the leader (docs/spec/groups.md#headers).
 */
export function updateCardTools(toolbar, { canClose, canSplitX, canSplitY, canGroupX, canGroupY, leads, leader, fullscreen }) {
  for (const button of toolbar.querySelectorAll(".chrome__act")) {
    const action = button.dataset.do;
    const hidden = action === "leader" ? !leads : button.hidden;
    if (button.hidden !== hidden) button.hidden = hidden;
    // A fullscreen card does not change the layout, so adding a tab, splitting, grouping, leading and closing wait for the restore.
    const layout = ["add", "x", "y", "gx", "gy", "leader", "close"].includes(action);
    const disabled = fullscreen && layout ? true
      : action === "close" ? !canClose : action === "x" ? !canSplitX : action === "y" ? !canSplitY
        : action === "gx" ? !canGroupX : action === "gy" ? !canGroupY : false;
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
    if (action === "leader") {
      const pressed = String(leader);
      if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    }
    if (button.title !== title) button.title = title;
    if (button.getAttribute("aria-label") !== title) button.setAttribute("aria-label", title);
  }
}
