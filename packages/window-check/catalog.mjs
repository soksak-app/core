// The record catalog of a window check (docs/spec/logging.md#catalog): the event catalog of core, which the package ships as
// core-events.json, a copy of docs/spec/events.json of the same core release, joined with the event catalogs of the plugins and
// sidecars that a configuration folder installed. A check declares the records it reads against it (prepareFixture, untilEventLines,
// Session.transcript), so a plugin repository reads the catalog of the core release that it checks against without a core path.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { composeCatalogs } from "@soksak/log-contract";
import { validateManifest, validateSidecar } from "@soksak/plugin-api";

/** The path of the event catalog of core that the package ships. */
export const CORE_CATALOG = fileURLToPath(new URL("./core-events.json", import.meta.url));

/** The event catalog of core. */
export const coreCatalog = () => JSON.parse(readFileSync(CORE_CATALOG, "utf8"));

/** The record of plugins/installed.json of a configuration folder, or null for a folder that installed nothing. */
function installedRecord(directory) {
  const file = join(directory, "plugins", "installed.json");
  let installed;
  try {
    installed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    // default: a configuration folder without installed.json has installed no plugin and no sidecar.
    if (error.code === "ENOENT") return null;
    throw new Error(`${file}: ${error.message}`, { cause: error });
  }
  if (installed?.format !== 3) throw new Error(`${file}: plugins/installed.json: format must be 3, found ${JSON.stringify(installed?.format)}`);
  return { file, installed };
}

/**
 * The event catalogs of the sidecars that installed.json of the plugins folder of a configuration folder records: each recorded folder
 * holds a `sidecar.json`, whose member `events` names the catalog file (docs/spec/sidecars.md). A sidecar without the member
 * declares no catalog. A file that is missing, not JSON or of another format is an error that names the file.
 */
export function installedSidecarCatalogs(directory) {
  const record = installedRecord(directory);
  if (record === null) return [];
  const catalogs = [];
  for (const [name, { path }] of Object.entries(record.installed.sidecars ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const manifest = join(directory, path, "sidecar.json");
    const sidecar = validateSidecar(JSON.parse(readFileSync(manifest, "utf8")));
    if (sidecar.events === undefined) continue;
    const catalog = join(directory, path, sidecar.events);
    try {
      catalogs.push(JSON.parse(readFileSync(catalog, "utf8")));
    } catch (error) {
      throw new Error(`${catalog}: the event catalog of the sidecar ${name}: ${error.message}`, { cause: error });
    }
  }
  return catalogs;
}

/** The event catalogs of the installed plugins that declare `events` in plugin.json, as `{kind: "plugin", id, catalog, source}`. */
export function installedPluginCatalogs(directory) {
  const record = installedRecord(directory);
  if (record === null) return [];
  const catalogs = [];
  for (const [id, entry] of Object.entries(record.installed.plugins ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof entry?.path !== "string" || entry.path === "") throw new Error(`${record.file}: installed plugin ${id} has no path`);
    const manifestFile = join(directory, entry.path, "plugin.json");
    let manifest;
    try {
      manifest = validateManifest(JSON.parse(readFileSync(manifestFile, "utf8")));
    } catch (error) {
      throw new Error(`${manifestFile}: ${error.message}`, { cause: error });
    }
    if (manifest.id !== id) throw new Error(`${manifestFile}: plugin id ${manifest.id} does not match installed plugin ${id}`);
    if (manifest.events === undefined) continue;
    const catalogFile = join(directory, entry.path, manifest.events);
    let catalog;
    try {
      catalog = JSON.parse(readFileSync(catalogFile, "utf8"));
    } catch (error) {
      throw new Error(`${catalogFile}: event catalog of plugin ${id}: ${error.message}`, { cause: error });
    }
    catalogs.push({ kind: "plugin", id, catalog, source: catalogFile });
  }
  return catalogs;
}

/** The catalog `base` joined with the catalogs of the plugins and sidecars installed in the configuration folder `directory`. */
export const catalogOf = (base, directory) => composeCatalogs(base, ...installedPluginCatalogs(directory), ...installedSidecarCatalogs(directory));

/** The declarations of the records that a check of the application of `configDir` reads: the core catalog joined with the installed ones. */
export const recordCatalog = (configDir) => catalogOf(coreCatalog(), configDir);
