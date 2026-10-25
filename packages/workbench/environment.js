// Registers the environment.json of the application and the manifests of the plugins installed in the configuration directory.
//
// The workbench does not know any specific plugin. The plugin list comes from /installed-plugins.json that the host provides
// (docs/spec/installation.md), and the layout of a new space and the sidebar defaults come from environment.json.
import { contributionsOf, installContributions } from "./contributions.js";
import { registry as exposure } from "./exposure.js";
import { declarePluginSidecars } from "./plugin-host.js";
import { declareProjectData } from "./plugin-data.js";
import { registerPlugin, registerSection } from "./registry.js";
import { compositionKindOf } from "./surface-composition-kind.js";
import { setPluginSettings, setSidebarDefaults } from "./settings.js";
import {
  checkReferences, manifestSidecars, mergeExposes, modulePath, validateDiagnostics, normalizeSidebarDefaults, validateEnvironment,
  validateInstalledPlugins,
} from "@soksak/plugin-api";

let loaded = null;
let units = [];
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
    pluginId, declarations: surface.declarations, sidecars: surface.sidecars,
    // default: a surface without surface.unload (undeclared, or beside background) is never unloaded.
    unload: surface.unload ?? false,
    contributions: (point) => contributionsOf(pluginId, point) });
}

/* Diagnostic module loaded for each plugin id in a diagnostic build. The registration starts the loading and waits for it when it raises a surface. */
let diagnosticModules = Promise.resolve(new Map());

/**
 * Validates environment.json and the list of installed plugins (with manifests) and registers the plugins, sections and sidebar defaults.
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
  const installed = validateInstalledPlugins(installedDocument);
  const manifests = installed.map(({ package: name, version, manifest, sidecars }) => ({ name, manifest, version, sidecars }));
  // A dependency that names the package of an installed plugin is a plugin dependency, not a sidecar (docs/spec/plugins.md#pluginjson).
  const pluginNames = new Set(installed.map((plugin) => plugin.package));
  installContributions(installed);
  checkReferences(environment, manifests.map((m) => m.manifest));
  const diagnosticPlugins = Object.fromEntries(installed.filter((plugin) => plugin.diagnostics)
    .map((plugin) => [plugin.package, validateDiagnostics(plugin.manifest, plugin.diagnostics)]));
  // default: settings is an optional field of environment.json; without it no plugin settings are overridden.
  setPluginSettings(manifests.map((m) => m.manifest), environment.settings ?? {});
  diagnosticModules = Promise.all(installed.filter((plugin) => diagnosticPlugins[plugin.package]).map(async (plugin) =>
    [plugin.id, await import(`/${modulePath(plugin.package, diagnosticPlugins[plugin.package].module)}`)]))
    .then((entries) => new Map(entries));
  for (const { name, manifest, sidecars } of manifests) {
    // default: the diagnostic module exists only in some plugins of a diagnostic build; without it the value is null.
    const diagnostics = diagnosticPlugins[name] ?? null;
    // default: dependencies is an optional field of plugin.json; without it the plugin has no sidecars. hostOperations is optional
    // too; without it the plugin host calls no operation of a sidecar (docs/plans/plugin-host-routes.md rule 8).
    declarePluginSidecars(manifest.id, manifestSidecars(manifest, pluginNames)
      // default: a sidecar that the installed document holds no facts for has no declaration (null), so the plugin host refuses its operations.
      .map((sidecar) => ({ name: sidecar, declared: manifest.hostOperations?.[sidecar] ?? [], declaration: sidecars?.[sidecar] ?? null })));
    // default: exposes is an optional field of plugin.json; without it there is no declaration (docs/spec/plugins.md).
    const exposes = diagnostics ? mergeExposes(manifest.exposes ?? {}, diagnostics.exposes) : manifest.exposes;
    if (manifest.surface) {
      registerPlugin({
        id: manifest.id, name: manifest.name, mark: manifest.mark, svg: manifest.icon,
        // default: preview is an optional field of plugin.json; without it there is no preview ink (null).
        ink: manifest.preview?.ink ?? null,
        // default: background is an optional field of plugin.json; without it there is no background session (null).
        background: manifest.background ?? null,
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
        surface: surfaceOf(name, manifest.id, {
          ...manifest.surface,
          // default: exposes is an optional field of plugin.json; without it there is no declaration.
          declarations: exposes ?? {},
          sidecars: manifestSidecars(manifest, pluginNames),
        }),
      });
    }
    // default: sections is an optional field of plugin.json; without it there are no sections.
    for (const section of manifest.sections ?? []) registerSection(section);
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
  }));
  loaded = environment;
}

/** Diagnostic module of a plugin id. It exists only in some plugins of a diagnostic build; without it the value is null. A load failure is a rejection. */
// default: a plugin that declares no diagnostic module has no diagnostics (docs/spec/plugins.md).
export const pluginDiagnostics = (id) => diagnosticModules.then((modules) => modules.get(id) ?? null);

/**
 * Returns the installed plugins in id order. The settings window and the plugin list of the library use it.
 * It includes plugins without a surface. An item is {id, name, description, version, surface, composition, sections, dependencies}.
 */
export const pluginUnits = () => units;

/** Returns the loaded environment.json. Throws before it is loaded. */
export function environment() {
  if (!loaded) throw new Error("environment is not loaded");
  return loaded;
}
