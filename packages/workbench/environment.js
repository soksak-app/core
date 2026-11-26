// Registers the environment.json of the application and the manifests of the plugins installed in the configuration directory.
//
// The workbench does not know any specific plugin. The plugin list comes from /installed-plugins.json that the host provides
// (docs/spec/installation.md), and the layout of a new space and the sidebar defaults come from environment.json.
import { contributionsOf, installContributions } from "./contributions.js";
import { registry as exposure } from "./exposure.js";
import { declareProjectData } from "./plugin-data.js";
import { registerDialog, registerPlugin, registerSection } from "./registry.js";
import { compositionKindOf } from "./surface-composition-kind.js";
import { setPluginSettings, setSidebarDefaults } from "./settings.js";
import {
  checkReferences, manifestSidecars, mergeExposes, modulePath, validateDiagnostics, normalizeSidebarDefaults, validateEnvironment,
  acceptInstalledPlugins, PLUGIN_CATEGORIES,
} from "@soksak/plugin-api";

let loaded = null;
let units = [];
let refused = new Set();
// The plugin of each unserved requirement: plugin id -> the plugin category that no loaded plugin serves (docs/spec/plugins.md#plugin-categories).
let unserved = new Map();
// The loaded and enabled plugins of each plugin category, {category: [{id, name}]}, in the order of their ids.
let categories = {};
let starter = null;
let registry = null;

/** Name of the starter pack that the first run installs. null if environment.json has none (docs/spec/installation.md). */
export function starterPack() {
  return starter;
}

/** Location of the default registry index that the first run sets. null if environment.json has none (docs/spec/installation.md). */
export function defaultRegistry() {
  return registry;
}

/** Converts a surface declaration into a function that returns the surface target for a tab id. */
function surfaceOf(name, pluginId, surface) {
  return (tabId) => ({ composition: surface.composition, surfaceId: tabId,
    pluginId, declarations: surface.declarations, sidecars: surface.sidecars, diagnostics: surface.diagnostics,
    // default: programs is an optional field of plugin.json; a surface without it runs no program (null).
    programs: surface.programs,
    // default: a surface without surface.unload (undeclared, or beside background) is never unloaded.
    unload: surface.unload ?? false,
    contributions: (point) => contributionsOf(pluginId, point) });
}

/**
 * Converts a section declaration into a function that returns the target of its section surface for a surface id and the start
 * value section {id, sidebar, card} (docs/spec/plugins.md#sections). A section surface has no tab parameters. It carries the programs of
 * the plugin, which every view of the plugin may run (docs/spec/native-surfaces.md#program-runs).
 */
function sectionSurfaceOf(pluginId, section, declarations, diagnostics, sidecars, programs) {
  return (surfaceId, start) => ({ composition: section.composition, surfaceId, pluginId, declarations, sidecars, diagnostics, programs,
    // default: a section without unload is never unloaded, as a surface without surface.unload (docs/spec/plugins.md#memory-saver).
    unload: section.unload ?? false,
    params: null, section: start,
    contributions: (point) => contributionsOf(pluginId, point) });
}

/**
 * Converts a dialog declaration into a function that returns the target of its dialog surface for the surface of the view that opens
 * it and the params of the open call (docs/spec/plugins.md#dialogs). A window holds one dialog, so the id names the plugin and the
 * dialog; its "/" keeps it out of the tab surfaces, and no space has the id dialog.
 * It carries the programs of the plugin, as a section surface does.
 */
function dialogSurfaceOf(pluginId, name, { page, regions }, declarations, diagnostics, sidecars, programs) {
  // default: regions is optional in a dialog; a dialog without it declares no region, as a view composition without regions.
  const composition = regions === undefined ? { kind: "view", page } : { kind: "view", page, regions };
  return (opener, params) => ({ composition, surfaceId: `dialog/${pluginId}/${name}`, pluginId, declarations, sidecars,
    diagnostics, programs, unload: false, params, section: null, dialog: { name, opener },
    contributions: (point) => contributionsOf(pluginId, point) });
}

/* Diagnostic module loaded for each plugin id in a diagnostic build. The registration starts the loading and waits for it when it raises a surface. */
let diagnosticModules = Promise.resolve(new Map());

/**
 * Leaves out each plugin that requires a plugin category which no plugin still loaded serves, and repeats until every loaded plugin's
 * requirements are served. A plugin of a category does not require that category (plugin-api), so a plugin is left out only when the
 * plugins that remain do not serve it. It returns the loaded plugins and the category of each left-out plugin's unserved requirement.
 */
function loadServing(plugins) {
  const left = new Map();
  let candidates = plugins;
  for (;;) {
    const served = new Set(candidates.flatMap((plugin) => plugin.manifest.categories ?? []));
    const missing = candidates.filter((plugin) => (plugin.manifest.requires ?? []).some((category) => !served.has(category)));
    if (missing.length === 0) return { plugins: candidates, unserved: left };
    for (const plugin of missing) {
      const category = plugin.manifest.requires.find((item) => !served.has(item));
      left.set(plugin.id, category);
    }
    candidates = candidates.filter((plugin) => !missing.includes(plugin));
  }
}

/** The loaded plugins that serve each plugin category of core, {category: [{id, name}]}, in the order of their ids (docs/spec/plugins.md#plugin-categories). */
function servingPlugins(plugins) {
  return Object.fromEntries(PLUGIN_CATEGORIES.map((category) => [category, plugins
    .filter((plugin) => (plugin.manifest.categories ?? []).includes(category))
    .toSorted((a, b) => a.manifest.id.localeCompare(b.manifest.id))
    .map((plugin) => ({ id: plugin.manifest.id, name: plugin.manifest.name }))]));
}

/**
 * Validates environment.json and the list of installed plugins (with manifests) and registers the plugins, sections and sidebar defaults.
 * It returns the errors of the installed plugins that it refuses and leaves out, which the page shows; an environment.json that it cannot
 * use throws.
 * It registers synchronously so the first screen is drawn before the first await (docs/spec/native-host.md#page-start). The host of a diagnostic build sends the declaration of
 * diagnostics.json for each plugin; that declaration is added to the surface declaration of the plugin, and the diagnostic module is given out as pluginDiagnostics.
 */
export function installEnvironment(environmentDocument, installedDocument) {
  if (loaded) throw new Error("environment is already loaded");
  const environment = validateEnvironment(environmentDocument);
  // default: starter is an optional field of environment.json; without it the first run installs nothing.
  starter = environment.starter ?? null;
  // default: if environment.json has no registry, there is no default registry for the first run to set.
  registry = environment.registry ?? null;
  const { plugins: accepted, errors: refusals, refused: refusedIds } = acceptInstalledPlugins(installedDocument);
  refused = new Set(refusedIds);
  // A plugin whose required category no loaded plugin serves is not loaded, and the other plugins start (docs/spec/plugins.md#plugin-categories).
  const serving = loadServing(accepted);
  const installed = serving.plugins;
  unserved = serving.unserved;
  categories = servingPlugins(installed);
  const errors = [...refusals, ...[...unserved].map(([id, category]) => `plugin ${id} requires a ${category} plugin, and no loaded plugin is one`)];
  const manifests = installed.map(({ package: name, version, manifest }) => ({ name, manifest, version }));
  // A dependency that names the package of an installed plugin is a plugin dependency, not a sidecar (docs/spec/plugins.md#pluginjson).
  const pluginNames = new Set(installed.map((plugin) => plugin.package));
  // The id of the installed plugin of each package, which the view calls name (docs/spec/plugins.md#pluginjson).
  const pluginIds = new Map(installed.map((plugin) => [plugin.package, plugin.id]));
  installContributions(installed);
  checkReferences(environment, manifests.map((m) => m.manifest));
  const diagnosticPlugins = Object.fromEntries(installed.filter((plugin) => plugin.diagnostics)
    .map((plugin) => [plugin.package, validateDiagnostics(plugin.manifest, plugin.diagnostics)]));
  // default: settings is an optional field of environment.json; without it no plugin settings are overridden.
  setPluginSettings(manifests.map((m) => m.manifest), environment.settings ?? {}, categories);
  diagnosticModules = Promise.all(installed.filter((plugin) => diagnosticPlugins[plugin.package]).map(async (plugin) =>
    [plugin.id, await import(`/${modulePath(plugin.package, diagnosticPlugins[plugin.package].module)}`)]))
    .then((entries) => new Map(entries));
  for (const { name, manifest } of manifests) {
    // default: the diagnostic module exists only in some plugins of a diagnostic build; without it the value is null.
    const diagnostics = diagnosticPlugins[name] ?? null;
    // default: exposes is an optional field of plugin.json; without it there is no declaration (docs/spec/plugins.md).
    const exposes = diagnostics ? mergeExposes(manifest.exposes ?? {}, diagnostics.exposes) : manifest.exposes;
    if (manifest.surface) {
      registerPlugin({
        id: manifest.id, name: manifest.name, mark: manifest.mark, svg: manifest.icon,
        // default: preview is an optional field of plugin.json; without it there is no preview ink (null).
        ink: manifest.preview?.ink ?? null,
        // default: background is an optional field of plugin.json; without it there is no background session (null).
        background: manifest.background ?? null,
        // default: sessions is an optional field of plugin.json; without it the surfaces open no owned session (null). With it, the
        // value is the one sidecar that the plugin declares in dependencies, which holds its owned sessions (docs/spec/plugins.md#owned-sessions).
        sessions: manifest.sessions === true ? manifestSidecars(manifest, pluginNames)[0] : null,
        // default: surface.drop is an optional field; without it that surface does not accept drops (null).
        drop: manifest.surface?.drop ?? null,
        // default: surface.params is optional; a plugin without it opens tabs without parameters (null).
        params: manifest.surface.params ?? null,
        // default: surface.opens is optional; a plugin without it opens no file (null).
        opens: manifest.surface.opens?.extensions ?? null,
        // default: surface.save is optional; a plugin without it cannot save before a modified tab closes (null).
        save: manifest.surface.save ?? null,
        // default: surface.menu is optional; a right click on a surface of a plugin without it opens the page menu (null).
        menu: manifest.surface.menu ?? null,
        // default: surface.program is optional; a plugin without it reports no program state (null).
        program: manifest.surface.program ?? null,
        // The statuses that declare activity, which the activity of each tab of the plugin follows (docs/spec/activity.md).
        // default: exposes and its status are optional; a plugin without them declares no activity.
        activity: (exposes?.status ?? []).filter((entry) => entry.activity === true).map(({ name }) => name),
        // The ids of the installed plugins whose packages the plugin lists in dependencies, whose statuses and project data its views
        // read and follow (docs/spec/plugins.md#project-data).
        // default: dependencies is an optional field of plugin.json; without it the plugin depends on no plugin.
        plugins: Object.keys(manifest.dependencies ?? {}).filter((name) => pluginIds.has(name)).map((name) => pluginIds.get(name)),
        surface: surfaceOf(name, manifest.id, {
          ...manifest.surface,
          // default: exposes is an optional field of plugin.json; without it there is no declaration.
          declarations: exposes ?? {},
          // The diagnostic declaration goes to the start values of each view of the plugin, so the view page requests no
          // diagnostics.json (docs/spec/plugins.md#diagnostic-declarations).
          diagnostics,
          sidecars: manifestSidecars(manifest, pluginNames),
          // default: programs is an optional field of plugin.json; without it the plugin runs no program (null).
          programs: manifest.programs ?? null,
        }),
      });
    }
    // default: sections is an optional field of plugin.json; without it there are no sections.
    for (const section of manifest.sections ?? []) {
      registerSection({ id: section.id, name: section.name, height: section.height, plugin: manifest.id,
        // default: actions is an optional field of a section; without it the header has no button.
        actions: section.actions ?? [],
        // default: exposes is an optional field of plugin.json; without it there is no declaration.
        surface: sectionSurfaceOf(manifest.id, section, exposes ?? {}, diagnostics, manifestSidecars(manifest, pluginNames), manifest.programs ?? null) });
    }
    // default: dialogs is an optional field of plugin.json; without it the plugin opens no dialog.
    for (const [name, dialog] of Object.entries(manifest.dialogs ?? {})) {
      registerDialog({ plugin: manifest.id, name, page: dialog.page,
        // default: exposes is an optional field of plugin.json; without it there is no declaration.
        surface: dialogSurfaceOf(manifest.id, name, dialog, exposes ?? {}, diagnostics, manifestSidecars(manifest, pluginNames), manifest.programs ?? null) });
    }
    if (exposes) exposure.declare(manifest.id, exposes);
    // default: data is an optional field of plugin.json; without it the plugin declares no project data.
    declareProjectData(manifest.id, manifest.data ?? {});
  }
  setSidebarDefaults(normalizeSidebarDefaults(environment, manifests.map(({ manifest }) => manifest)));
  units = manifests.map(({ manifest, version }) => ({
    id: manifest.id, name: manifest.name, description: manifest.description, version, surface: Boolean(manifest.surface),
    composition: compositionKindOf(manifest.surface),
    // default: a plugin without a surface declares no surface.unload.
    unload: manifest.surface?.unload ?? false,
    // default: sections is an optional field of plugin.json; without it there are no sections.
    sections: (manifest.sections ?? []).map((s) => s.id),
    // default: dependencies is an optional field of plugin.json; without it there are no sidecars.
    dependencies: manifest.dependencies ?? {},
    // default: accounts is an optional field of plugin.json; without it the plugin keeps no accounts (docs/spec/plugins.md#accounts).
    accounts: manifest.accounts ?? null,
    // default: programs is an optional field of plugin.json; without it the plugin runs no program.
    programs: manifest.programs ?? {},
  }));
  loaded = environment;
  return errors;
}

/**
 * The accounts and the programs of an installed plugin, {accounts, programs}, whose accounts is null for a plugin without accounts; null
 * for a plugin that is not installed (docs/spec/plugins.md#accounts).
 */
export function pluginAccounts(id) {
  const unit = units.find((item) => item.id === id);
  // default: a plugin that the window did not load has no accounts in this window.
  return unit ? { accounts: unit.accounts, programs: unit.programs } : null;
}

/** Diagnostic module of a plugin id. It exists only in some plugins of a diagnostic build; without it the value is null. A load failure is a rejection. */
// default: a plugin that declares no diagnostic module has no diagnostics (docs/spec/plugins.md).
export const pluginDiagnostics = (id) => diagnosticModules.then((modules) => modules.get(id) ?? null);

/**
 * Returns the installed plugins in id order. The settings window and the plugin list of the library use it.
 * It includes plugins without a surface. An item is {id, name, description, version, surface, composition, sections, dependencies}.
 */
export const pluginUnits = () => units;

/** Returns the ids of the installed plugins whose entry or manifest the window refused (docs/spec/installation.md#serving-installed-plugins). */
export const refusedPlugins = () => refused;

/** Returns the plugins that are not loaded because a plugin category they require is unserved: a Map of plugin id to the category (docs/spec/plugins.md#plugin-categories). */
export const unmetPlugins = () => unserved;

/** Returns the loaded and enabled plugins of each plugin category of core, {category: [{id, name}]}, in the order of their ids (docs/spec/plugins.md#plugin-categories). */
export const pluginCategories = () => categories;

/** Returns the loaded environment.json. Throws before it is loaded. */
export function environment() {
  if (!loaded) throw new Error("environment is not loaded");
  return loaded;
}
