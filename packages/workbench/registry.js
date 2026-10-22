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
 * @param {string} section.status  declared UI status that draws the section
 */
export function registerSection(section) {
  if (registeredSections.some((s) => s.id === section.id)) {
    throw new Error(`section already registered: ${section.id}`);
  }
  registeredSections.push(section);
}

/** Returns the plugins in registration order. The `+` menu uses this order. */
export const plugins = () => registeredPlugins;

/** Looks up by id. Throws if the id is not registered. */
export function plugin(id) {
  const found = registeredPlugins.find((p) => p.id === id);
  if (!found) throw new Error(`unknown plugin: ${id}`);
  return found;
}

/** Returns whether the plugin is registered. A stored layout may have been made in another environment. */
export const hasPlugin = (id) => registeredPlugins.some((p) => p.id === id);

/** Decides whether it is a fixed window sidebar card. Registration is validated at the environment and storage boundaries. */
export const isPlace = (id) => id === "left" || id === "right";

/** Looks up by id. Throws if the id is not registered. */
export function section(id) {
  const found = registeredSections.find((s) => s.id === id);
  if (!found) throw new Error(`unknown section: ${id}`);
  return found;
}

/** Returns the names of a list of section ids in order. Throws if an id is not registered. A stored set is validated when it is loaded. */
/** Whether a section is registered. The section of a plugin that is not loaded remains in the set but is not registered (docs/spec/plugins.md). */
export const hasSection = (id) => registeredSections.some((s) => s.id === id);

/** Section name. The section of a plugin that is not loaded is shown as its id and the Korean text for "not loaded" in parentheses. */
export const sectionNames = (ids) => ids.map((id) => (hasSection(id) ? section(id).name : `${id} (불러오지 않음)`));
