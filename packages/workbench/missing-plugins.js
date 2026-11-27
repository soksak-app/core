// The sections of a set whose plugin is not loaded, and the texts, lines and chips that show them (docs/spec/plugins.md#missing-plugins).
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
 * The title, text and button of a group's warning, or null when the plugin needs no warning (a plugin that is reloading). The title names
 * the plugin and the text states its state and its section count (docs/spec/plugins.md#missing-plugins). The install button is absent when
 * the catalog does not list the plugin (latest is null).
 */
export function missingText(group) {
  const phrase = PHRASE[group.state];
  if (phrase === undefined) return null;
  const title = `${group.name}(${group.id})`;
  const text = `${phrase} 섹션 ${group.sections.length}개를 못 보여 준다.`;
  let button = null;
  if (group.state === "available" && group.latest !== null) button = { label: `${group.name} 설치`, command: "core.plugins.install", params: { plugin: group.id } };
  if (group.state === "disabled") button = { label: "켜기", command: "core.plugins.enable", params: { plugin: group.id } };
  if (group.state === "refused" || group.state === "requires") button = { label: "설치됨 보기", command: "core.plugins.browse", params: {} };
  return { title, text, button };
}

/**
 * The line of a group in the set editor of the settings page, or null when the group has no warning. It shows the title and the text of
 * the warning and its button; the sidebars show the same warning as a notice (sidebar-sections.js).
 */
export function missingLineNode(document, group) {
  const line = missingText(group);
  if (line === null) return null;
  const node = document.createElement("div");
  node.className = "missing-line missing-line--warn";
  node.setAttribute("role", "status");
  node.dataset.expose = "core.sidebar.missing";
  node.dataset.plugin = group.id;
  const label = document.createElement("span");
  label.className = "missing-line__text";
  label.textContent = `${line.title} ${line.text}`;
  node.title = label.textContent;
  node.append(label);
  if (line.button) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "missing-line__button";
    button.dataset.expose = "core.sidebar.missing";
    button.textContent = line.button.label;
    mark(button, line.button.command, line.button.params);
    node.append(button);
  }
  return node;
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
