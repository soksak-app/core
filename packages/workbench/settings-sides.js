// The sidebar list of the settings tab: the four rows of a side order, each with its set select, its switch and its order buttons
// (docs/spec/settings.md#작업-공간, docs/spec/settings.md#plugin-page). The workspace draws it for the fixed window sidebars, and a plugin page
// draws it for the window sidebars and the card sidebars of the plugin.
import { SIDE_NAMES } from "./window-sidebars.js";
import { sectionNames } from "./registry.js";
import { button, chip, element, row, select, toggle, badge } from "./settings-controls.js";
import { isOverridden, projectTitle, state, writeScope, shownValue, projectSelected } from "./settings-state.js";
import { editable } from "./settings-controls.js";
import { overridden, scopedValue } from "./settings.js";

/** The name of a side, which is the text of the side (docs/spec/settings.md#values). */
export const sideName = (side) => SIDE_NAMES[side];

/** The set that a link of the place and plugin selects, or off when no link stores one (docs/spec/settings.md#sidebar-choices). */
export function choiceOf(links, place, plugin) {
  const found = links.find((link) => link.place === place && link.plugin === plugin);
  return found ? found.set : "off";
}

/** The options of a set select: every set with its layout and its section count as the hint. */
const setOptions = (sets) => sets.map((set) => [set.id, `${set.title} (${set.layout === "tabs" ? "탭" : "목록"} · ${set.sections.length})`]);

/**
 * The set select of one place (docs/spec/settings.md#작업-공간). It runs core.settings.link with place, plugin, the chosen set as set, and the scope,
 * and it is disabled while disabled says so (a side that is off).
 */
export function linkSelect(place, plugin, { disabled = false } = {}) {
  const links = shownValue("links");
  const sets = shownValue("sets");
  const now = choiceOf(links, place, plugin);
  // default: a link without a plugin has an empty plugin part in its control name.
  return select(`link:${place}:${plugin ?? ""}`, [["off", "사용 안 함"], ...setOptions(sets)], now, {
    command: "core.settings.link",
    params: { place, plugin, scope: writeScope() },
    valueName: "set",
    disabled: disabled || !editable("links"),
    expose: "core.settings-tab.link",
  });
}

/**
 * The side list of an order (docs/spec/settings.md#작업-공간). order is the key of the order (sidebarOrder, or <plugin>.win.order and
 * <plugin>.card.order); place(side) is the place of a side's link; sideSwitch(side) names the switch of a side, or null when the rows have none.
 * The list shows the number, the side name, the project badge of an override, the set select, the switch and the order buttons.
 */
export function sideList({ order, place, plugin = null, sideSwitch = null, title = "사이드바" }) {
  const list = element("div", "set-sides");
  const now = shownValue(order);
  // A row marks each value it overrides with the badge of the project: its switch (workspace only), its link of its own place, or the order
  // (docs/spec/settings.md#작업-공간, docs/spec/settings.md#plugin-page).
  const workspace = sideSwitch !== null;
  const linkOverridden = (side) => isOverridden("links") && choiceOf(scopedValue("links", "project"), place(side), plugin) !== choiceOf(scopedValue("links", "common"), place(side), plugin);
  const rowOverridden = (side, switchKey) => isOverridden(order) || (workspace && isOverridden(switchKey)) || linkOverridden(side);
  now.forEach((side, index) => {
    const line = element("div", "set-side");
    line.dataset.side = side;
    line.append(element("span", "set-side__no", String(index + 1)), element("span", "set-side__name", sideName(side)));
    const switchKey = sideSwitch === null ? null : sideSwitch(side);
    const off = switchKey !== null && shownValue(switchKey) === false;
    if (state.scope === "project" && rowOverridden(side, switchKey)) {
      line.append(badge(`${projectTitle()} 값`, "acc", { expose: "core.settings-tab.override", key: side }));
    } else if (state.scope === "common" && switchKey !== null && isOverridden(switchKey)) {
      // The common scope shows the chip of a project override beside the switch, as scopeMarks does (docs/spec/settings.md#scope-of-a-control).
      line.append(chip(`${projectTitle()}: ${scopedValue(switchKey, "project") ? "켬" : "끔"}`, "warn", {
        expose: "core.settings-tab.applied", command: "core.settings-tab.scope", params: { scope: "project" }, key: `applied:${switchKey}`,
      }));
    }
    line.append(linkSelect(place(side), plugin, { disabled: off }));
    if (switchKey !== null) {
      const sw = toggle(switchKey, shownValue(switchKey), { disabled: !editable(switchKey), expose: "core.settings-tab.side" });
      sw.setAttribute("aria-label", `${sideName(side)} 사이드바 보이기`);
      line.append(sw);
    }
    const up = button("↑", { expose: "core.settings-tab.order", command: "core.settings.change", params: { key: order, value: swapped(now, index, index - 1), scope: writeScope() }, key: order, disabled: index === 0 || !editable(order), variant: "icon", title: "위로" });
    const down = button("↓", { expose: "core.settings-tab.order", command: "core.settings.change", params: { key: order, value: swapped(now, index, index + 1), scope: writeScope() }, key: order, disabled: index === now.length - 1 || !editable(order), variant: "icon", title: "아래로" });
    line.append(up, down);
    list.append(line);
  });
  // Each overridden key of the rows has one reset control: the switches, the links and the order of a workspace list (docs/spec/settings.md#작업-공간).
  const resetKeys = workspace ? [...now.map(sideSwitch), "links", order] : [order, "links"];
  const marks = resetKeys.filter((key) => state.scope === "project" && projectSelected() && overridden(key)).map((key) =>
    button(`${projectTitle()} 값 지우기`, { expose: "core.settings-tab.reset", command: "core.settings.reset", params: { key, scope: "project" }, key, variant: "sm" }));
  return row({ label: title, wide: true, control: list, key: order, extras: marks });
}

/** The order with the entries at a and b exchanged, which is the value that an order button writes (docs/spec/settings.md#작업-공간). */
function swapped(list, a, b) {
  const next = [...list];
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

/** The names of the sections of a set, for a line (docs/spec/settings.md#사이드바-세트). */
// default: a set without sections is labelled 섹션 없음.
export const sectionLine = (set) => sectionNames(set.sections).join(" · ") || "섹션 없음";
