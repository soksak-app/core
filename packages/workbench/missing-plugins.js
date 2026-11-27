// The sections of a set whose plugin is not loaded, and the lines and chips that show them (docs/spec/plugins.md#missing-plugins).
// The plugin states come from the plugin operations of this window; installed-plugins.js registers the provider at load, so a module
// that draws a set does not load the host.
import { mark } from "./commands.js";
import { hasSection } from "./registry.js";

const PHRASE = {
  absent: "플러그인이 없어", available: "플러그인이 없어", disabled: "플러그인이 꺼져 있어", refused: "플러그인을 불러오지 못해", requires: "플러그인을 불러오지 못해",
};

let rows = () => [];

/** Registers the function that returns the plugin rows of the plugin operations of this window (pluginRows of plugin-operations.js). */
export function setPluginRows(provider) {
  rows = provider;
}

/** The plugin rows that decide the states of the missing plugins. */
export const pluginRowsNow = () => rows();

/**
 * The missing plugins of a set's section ids, one group per plugin in the order of the first section, with the sections of the plugin
 * that are not loaded. state is the row state of the plugin, or absent when no row exists. The plugin id is the text before the first `.`.
 */
export function missingGroups(sectionIds, pluginRows) {
  const groups = new Map();
  for (const id of sectionIds) {
    if (hasSection(id)) continue;
    const plugin = id.slice(0, id.indexOf("."));
    if (!groups.has(plugin)) {
      // default: a plugin without a row is absent, with no latest version and its id as its name.
      const row = pluginRows.find((r) => r.id === plugin) ?? null;
      groups.set(plugin, { id: plugin, name: row?.name ?? plugin, sections: [], state: row?.state ?? "absent", latest: row?.latest ?? null }); // default: see the row above.
    }
    groups.get(plugin).sections.push(id);
  }
  return [...groups.values()];
}

/**
 * The text and the button of a group's warning line, or null when the plugin needs no line (a plugin that is reloading).
 * The install button is absent when the catalog does not list the plugin (latest is null).
 */
export function missingText(group) {
  const phrase = PHRASE[group.state];
  if (phrase === undefined) return null;
  const text = `${group.name}(${group.id}) ${phrase} 섹션 ${group.sections.length}개를 못 보여 준다.`;
  let button = null;
  if (group.state === "available" && group.latest !== null) button = { label: `${group.name} 설치`, command: "core.plugins.install", params: { plugin: group.id } };
  if (group.state === "disabled") button = { label: "켜기", command: "core.plugins.enable", params: { plugin: group.id } };
  if (group.state === "refused" || group.state === "requires") button = { label: "설치됨 보기", command: "core.plugins.browse", params: {} };
  return { text, button };
}

/**
 * The warning of a sidebar's status line: the newest group that has a line, which is the last one in set order, and the count of the other
 * groups with a line. It is null when no group has a line (docs/spec/plugins.md#missing-plugins).
 */
export function warningOf(groups) {
  const lines = groups.map((group) => ({ group, line: missingText(group) })).filter((item) => item.line !== null);
  if (lines.length === 0) return null;
  const { group, line } = lines.at(-1);
  return { plugin: group.id, text: line.text, button: line.button, others: lines.length - 1 };
}

/** The text that a warning shows: its text and ` +<n>개 더` when other plugins are missing too. */
export function shownWarningText(warning) {
  return warning.others > 0 ? `${warning.text} +${warning.others}개 더` : warning.text;
}

/**
 * The line of a warning: the element core.sidebar.missing with the plugin id as its parameter, in the warning tone. The dot is shown in
 * the status line only. The text is cut by CSS and its whole text is the tooltip of the line.
 */
export function warningNode(document, warning, { dot = false } = {}) {
  const node = document.createElement("div");
  node.className = "missing-line missing-line--warn";
  node.setAttribute("role", "status");
  node.dataset.expose = "core.sidebar.missing";
  node.dataset.plugin = warning.plugin;
  node.title = shownWarningText(warning);
  if (dot) {
    const mark = document.createElement("span");
    mark.className = "missing-line__dot";
    mark.textContent = "●";
    node.append(mark);
  }
  const label = document.createElement("span");
  label.className = "missing-line__text";
  label.textContent = shownWarningText(warning);
  node.append(label);
  if (warning.button) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "missing-line__button";
    button.dataset.expose = "core.sidebar.missing";
    button.textContent = warning.button.label;
    mark(button, warning.button.command, warning.button.params);
    node.append(button);
  }
  return node;
}

/** The warning line of a group in a set line, or null when the group has no line (docs/spec/plugins.md#missing-plugins). */
export function missingLineNode(document, group) {
  const line = missingText(group);
  if (line === null) return null;
  return warningNode(document, { plugin: group.id, text: line.text, button: line.button, others: 0 });
}

/** The chip of a missing section in the set editor: dashed and struck through, with the tooltip `<name>(<id>) 플러그인 필요`. */
export function missingChipNode(document, sectionId, group) {
  const chip = document.createElement("span");
  chip.className = "set-chip set-chip--missing";
  chip.dataset.section = sectionId;
  chip.title = `${group.name}(${group.id}) 플러그인 필요`;
  chip.textContent = sectionId;
  return chip;
}
