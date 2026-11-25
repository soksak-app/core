import { WINDOW_SIDES } from "@soksak/plugin-api";
// Registry of plugins and sections.
//
// A plugin has two things, a `+` menu item and a surface, and it has no sidebar. The sidebar
// composition is assembled by the user as sets and connected in the settings. If a plugin owned a sidebar,
// the user could not change it.
//
// A section is one item that a sidebar can show. It is registered the same way as a plugin, except that it has
// no surface.

const registeredPlugins = [];
const registeredSections = [];
const registeredDialogs = [];
const registeredSettingsViews = [];

/**
 * Registers one plugin.
 *
 * @param {object} plugin
 * @param {string} plugin.id    id of the plugin kind; a tab holds this value
 *        @param {string} plugin.name  name shown in the `+` menu
 *        @param {string} plugin.mark  mark on the right of the menu and prefix of the tab title
 *        @param {string} plugin.svg   icon path on a 16×16 viewBox
 *        @param {string|null} plugin.ink theme token name of the library preview color; the default color if absent
 *        @param {object|null} plugin.background declaration of the persistent background session
 *        @param {string[]} [plugin.activity] the names of the statuses that declare activity (docs/spec/activity.md)
 *        @param {string|null} [plugin.program] the name of the status that carries the program state of the tabs (docs/spec/program-state.md)
 *        @param {(tabId: string) => {module: string, composition: object}} plugin.surface document that the surface shows
 *        and the validated composition permission declaration. One surface is one tab, so
 *        the argument is the id of the tab
 */
export function registerPlugin(plugin) {
  if (registeredPlugins.some((p) => p.id === plugin.id)) {
    throw new Error(`plugin already registered: ${plugin.id}`);
  }
  registeredPlugins.push(plugin);
}

/**
 * Registers one section that a sidebar can show.
 *
 * @param {object} section
 * @param {string} section.id    a set refers to the section by this id
 * @param {string} section.name  name shown in the sidebar
 * @param {object} section.surface  the surface that draws the section
 * @param {object[]} section.actions  the actions of its header, {icon, label, command}, in declared order (docs/spec/plugins.md#sections)
 */
export function registerSection(section) {
  if (!Array.isArray(section.actions)) throw new Error(`section ${section.id} actions must be an array`);
  if (registeredSections.some((s) => s.id === section.id)) {
    throw new Error(`section already registered: ${section.id}`);
  }
  registeredSections.push(section);
}

/**
 * Registers one dialog of a plugin (docs/spec/plugins.md#dialogs).
 *
 * @param {object} dialog
 * @param {string} dialog.plugin  the plugin that declares it
 * @param {string} dialog.name    its name in dialogs of plugin.json
 * @param {string} dialog.page    the page of the dialog
 * @param {(opener: string, params: unknown) => object} dialog.surface  the surface of the dialog that the view opener opens with params
 */
export function registerDialog(dialog) {
  if (registeredDialogs.some((d) => d.plugin === dialog.plugin && d.name === dialog.name)) {
    throw new Error(`dialog already registered: ${dialog.plugin} ${dialog.name}`);
  }
  registeredDialogs.push(dialog);
}

/** The dialog name of the plugin, or null when the plugin declares no dialog of that name. */
// default: null states that the plugin declares no dialog of that name, which the open call refuses.
export const dialog = (pluginId, name) => registeredDialogs.find((d) => d.plugin === pluginId && d.name === name) ?? null;

/**
 * Registers the settings view of a plugin (docs/spec/plugins.md#settings-views).
 *
 * @param {object} view
 * @param {string} view.plugin  the plugin that declares it
 * @param {() => object} view.surface  the settings surface of the plugin
 */
export function registerSettingsView(view) {
  if (registeredSettingsViews.some((v) => v.plugin === view.plugin)) throw new Error(`settings view already registered: ${view.plugin}`);
  registeredSettingsViews.push(view);
}

/** The settings view of the plugin, or null when the plugin declares none. */
// default: null states that the plugin declares no settings view, so its plugin page shows none.
export const settingsView = (pluginId) => registeredSettingsViews.find((v) => v.plugin === pluginId) ?? null;

/** Returns the plugins in registration order. The `+` menu uses this order. */
export const plugins = () => registeredPlugins;

/** Looks up by id. Throws if the id is not registered. */
export function plugin(id) {
  const found = registeredPlugins.find((p) => p.id === id);
  if (!found) throw new Error(`unknown plugin: ${id}`);
  return found;
}

/**
 * The ids of the plugins that draw a surface, in registration order: the plugins of the tab surfaces, then the plugins that declare
 * only sections. The application draws each of them natively (docs/spec/plugins.md#sections).
 */
export const surfacePlugins = () => [...new Set([...registeredPlugins.map((p) => p.id), ...registeredSections.map((s) => s.plugin)])];

/**
 * Whether a surface {plugin, kind} keeps its session through the background path: only a tab of a plugin with background does; a
 * section surface is not a tab (docs/spec/plugins.md#memory-saver).
 */
export const keepsBackground = ({ plugin: id, kind }) => kind === "tab" && Boolean(plugin(id).background);

/** Returns whether the plugin is registered. A stored layout may have been made in another environment. */
export const hasPlugin = (id) => registeredPlugins.some((p) => p.id === id);

/** Decides whether it is a fixed window sidebar card, whose id is the side of the window. Registration is validated at the environment and storage boundaries. */
export const isPlace = (id) => WINDOW_SIDES.includes(id);

/** Looks up by id. Throws if the id is not registered. */
export function section(id) {
  const found = registeredSections.find((s) => s.id === id);
  if (!found) throw new Error(`unknown section: ${id}`);
  return found;
}

/** Returns the names of a list of section ids in order. Throws if an id is not registered. A stored set is validated when it is loaded. */
/** Whether a section is registered. The section of a plugin that is not loaded remains in the set but is not registered (docs/spec/plugins.md). */
export const hasSection = (id) => registeredSections.some((s) => s.id === id);

/**
 * The plugin of a section surface `<space id>/<sidebar id>/<section id>` (docs/spec/plugins.md#sections), or null for a tab surface
 * and for a section that is not registered.
 */
export function sectionSurfacePlugin(surface) {
  const parts = surface.split("/");
  if (parts.length !== 3) return null;
  return hasSection(parts[2]) ? section(parts[2]).plugin : null;
}

/** Section name. The section of a plugin that is not loaded is shown as its id and the Korean text for "not loaded" in parentheses. */
export const sectionNames = (ids) => ids.map((id) => (hasSection(id) ? section(id).name : `${id} (불러오지 않음)`));
