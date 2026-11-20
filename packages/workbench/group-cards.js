// The drawing of the group cards of a space (docs/spec/groups.md#drawing): each group card is one container, its frame of the card
// border and radius on its drawn rectangle filled with the color of its level, and its header, the top band inside the frame, with
// the name of the group and the head buttons of the group in the style of the head of a content card.
import { bind } from "./commands.js";
import { declaredIcons as icons } from "./icons.js";
import { CHROME } from "./chrome-metrics.js";
import { currentGroupLook } from "./settings.js";
import declaration from "./workbench.json" with { type: "json" };

/** The names of the card tools, declared in workbench.json for both workbenches (docs/spec/example-model.md#card-tools). */
const names = declaration.cardTools;
const svg = (path) => `<svg viewBox="0 0 16 16" aria-hidden="true">${path}</svg>`;

/**
 * The head buttons of the group card id in the order of docs/spec/groups.md#headers: the two splits, the two group splits, enabled while
 * their group succeeds, the leader button in a level of two or more members, fullscreen and close; a group header holds no add button.
 * Each is {do, expose, command, params, title, icon, enabled, pressed}. A fullscreen card holds the layout, so every button that changes it waits.
 */
export function groupHeadTools(tree, id, { fullscreen }) {
  const held = fullscreen !== null;
  const changes = (tool, can) => ({ ...tool, enabled: !held && can, title: held ? names["layout-held"] : tool.title, pressed: false });
  const tools = [
    changes({ do: "x", expose: "core.group.split-x", command: "core.card.menu", params: { card: id, menu: "split-x" }, title: names["split-x"],
      icon: "card-split-x" }, tree.canSplit(id, "right")),
    changes({ do: "y", expose: "core.group.split-y", command: "core.card.menu", params: { card: id, menu: "split-y" }, title: names["split-y"],
      icon: "card-split-y" }, tree.canSplit(id, "bottom")),
    changes({ do: "gx", expose: "core.group.group-x", command: "core.card.menu", params: { card: id, menu: "group-x" }, title: names["group-x"],
      icon: "card-group-x" }, tree.canGroup(id, "right")),
    changes({ do: "gy", expose: "core.group.group-y", command: "core.card.menu", params: { card: id, menu: "group-y" }, title: names["group-y"],
      icon: "card-group-y" }, tree.canGroup(id, "bottom")),
  ];
  const parent = tree.parentOf(id);
  if (tree.leadCount(parent) >= 2) {
    tools.push({ ...changes({ do: "leader", expose: "core.card.leader", command: "core.group.leader", params: { card: id }, title: names.leader,
      icon: "card-leader" }, true), pressed: tree.leaderOf(parent) === id });
  }
  // The fullscreen button stays enabled while its group card is fullscreen, so a second press restores the arrangement.
  const whole = fullscreen === id;
  tools.push({ do: "fullscreen", expose: "core.group.fullscreen", command: "core.card.fullscreen", params: { card: id },
    title: whole ? names.restore : names.fullscreen, icon: whole ? "card-restore" : "card-expand", enabled: true, pressed: whole });
  tools.push(changes({ do: "group-menu", expose: "core.group.close", command: "core.group.menu", params: { group: id }, title: names["group-menu"],
    icon: "card-close" }, true));
  return tools;
}

/**
 * Creates the element of the group card id: the frame with its header, the name, the button row and the tool menu button ⋯, which the
 * header shows in place of its folded buttons (docs/spec/groups.md#headers).
 */
function createGroupCard(id) {
  const el = document.createElement("section");
  el.className = "group";
  el.dataset.expose = "core.group";
  el.dataset.groupCard = id;
  bind(el, "core.card.focus", { card: id });
  const head = document.createElement("header");
  head.className = "group__head";
  head.dataset.expose = "core.group.header";
  const name = document.createElement("span");
  name.className = "group__name";
  name.dataset.expose = "core.group.name";
  bind(name, "core.card.focus", { card: id });
  const acts = document.createElement("span");
  acts.className = "chrome__acts";
  const more = document.createElement("button");
  more.type = "button";
  more.className = "chrome__more";
  more.dataset.expose = "core.card.tools";
  more.title = "카드 도구";
  more.setAttribute("aria-label", more.title);
  more.innerHTML = svg(icons["card-more"]);
  bind(more, "core.card.tools", { card: id });
  head.append(name, acts, more);
  el.append(head);
  return el;
}

/** Draws the buttons of a group header, replacing the row only when the set of buttons changed, so a press keeps its node. */
function drawTools(acts, tools) {
  const key = tools.map((tool) => tool.do).join(",");
  if (acts.dataset.tools !== key) {
    acts.dataset.tools = key;
    acts.replaceChildren(...tools.map((tool) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chrome__act";
      button.dataset.do = tool.do;
      button.dataset.expose = tool.expose;
      bind(button, tool.command, tool.params);
      return button;
    }));
  }
  tools.forEach((tool, k) => {
    const button = acts.children[k];
    if (button.disabled !== !tool.enabled) button.disabled = !tool.enabled;
    if (button.title !== tool.title) {
      button.title = tool.title;
      button.setAttribute("aria-label", tool.title);
    }
    const pressed = tool.do === "fullscreen" || tool.do === "leader" ? String(tool.pressed) : null;
    if (pressed !== null && button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    if (button.dataset.icon !== tool.icon) {
      button.dataset.icon = tool.icon;
      button.innerHTML = svg(icons[tool.icon]);
    }
  });
}

/** The share of the focus color in the frame of a group card d levels above the focused card, group-focus-fade to the power d. */
const FOCUS_FADE = Number(CHROME["group-focus-fade"]);

/**
 * Marks the frame of a group card that holds the focused card: data-focus is the number of levels d up to it, and --group-focus the
 * share of the focus color that the stylesheet mixes into its frame (docs/spec/groups.md#focus); a frame outside the focus has neither.
 */
function markHeldFocus(el, d) {
  if (d === null) {
    if (el.dataset.focus !== undefined) delete el.dataset.focus;
    if (el.style.getPropertyValue("--group-focus") !== "") el.style.removeProperty("--group-focus");
    return;
  }
  const share = `${100 * FOCUS_FADE ** d}%`;
  if (el.dataset.focus !== String(d)) el.dataset.focus = String(d);
  if (el.style.getPropertyValue("--group-focus") !== share) el.style.setProperty("--group-focus", share);
}

/**
 * Draws the group cards of the tree on the plane element planeEl (docs/spec/groups.md#drawing): rects is the drawn rectangle of each
 * shown group card by id, which a fullscreen group card gives the group cards inside it, head the height of a header and focused the
 * focused content card, whose group cards mark their frames. A group card that rects does not hold is hidden; the element of a group
 * card that the tree no longer holds is removed. The frames stand below the cards, so they are inserted before the first card.
 */
export function drawGroupCards(planeEl, tree, rects, { head, fullscreen, focused }) {
  const live = new Set();
  const first = planeEl.querySelector(":scope > .card");
  for (const { id, node } of tree.order()) {
    if (!node) continue;
    live.add(id);
    let el = planeEl.querySelector(`:scope > .group[data-group-card="${CSS.escape(id)}"]`);
    if (!el) {
      el = createGroupCard(id);
      planeEl.insertBefore(el, first);
    }
    const rect = rects.get(id);
    el.hidden = rect === undefined;
    if (!rect) continue;
    const look = currentGroupLook(tree.level(id) + 1);
    Object.assign(el.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px`, background: look.body });
    markHeldFocus(el, tree.focusDistance(id, focused));
    const header = el.querySelector(".group__head");
    header.style.height = `${head}px`;
    header.style.backgroundColor = look.head;
    header.style.borderBottomColor = look.line;
    const name = header.querySelector(".group__name");
    if (name.textContent !== node.name) {
      name.textContent = node.name;
      name.title = node.name;
    }
    drawTools(header.querySelector(".chrome__acts"), groupHeadTools(tree, id, { fullscreen }));
  }
  for (const el of planeEl.querySelectorAll(":scope > .group")) if (!live.has(el.dataset.groupCard)) el.remove();
}
