// Validates the format of a plugin manifest (plugin.json) and of an application environment.json.
//
// The workbench validates each loaded file with these functions; plugins and applications validate their own
// files with the same functions in their tests.

/*
 * Path rules of the staged frontend.
 *
 * Workbench files are placed in the document root. Other modules are placed under `modules/<package.json name>/`
 * with their path inside the package. Runtime modules are placed in `runtime/`.
 */
import { createBinder } from "./binder.js";
import { causeCids } from "./calls.js";

export { INTERACTIVE, commandOf, createBinder, valueOf } from "./binder.js";
export { DOCUMENT_ACTIONS, DOCUMENT_NAME, observeRegionInsets, regionInsets } from "./document-region.js";
export { IMAGE_NAME } from "./image-region.js";
export { createPluginRuntime, LOG_LEVELS } from "./plugin-runtime.js";
export { createSurfaceContext, isLocalAbsolutePath, mountSurfaceModule, originFault, releaseSurfaceReady } from "./surface.js";
export { createSurfaceCompositionController } from "./surface-composition.js";
export { orderedSidecar } from "./sidecar-port.js";
export { CLIPBOARD_TYPES, ClipboardError, base64Of, bytesFrom, createClipboardBridge, shellQuotePath } from "./clipboard.js";
export { createLinkBridge } from "./links.js";
export { drawList } from "./list.js";
export { createOperationCids } from "./operation.js";
export { causeCids, createCalls, DEFAULT_CALL_TIMEOUT, ENDED_CALLS_KEPT, MAX_CALL_TIMEOUT, PEER_LOST_REASONS } from "./calls.js";
export { createSnapshotReceiver, createSnapshotSender, pullSnapshots, SNAPSHOT_EVENT, SNAPSHOT_ACK_EVENT, SNAPSHOT_REQUEST_COMMAND } from "./snapshots.js";

export const ENVIRONMENT = "environment.json";
export const MANIFEST = "plugin.json";
export const SIDECAR = "sidecar.json";
export const RUNTIME = "runtime";
/** The declaration file of the entries that the core exposes. It is in the workbench package root. */
export const EXPOSURE = "exposure.json";
/** The diagnostic declaration file at the root of a plugin. Only diagnostic builds stage it. */
export const DIAGNOSTICS = "diagnostics.json";
/** The list of plugin diagnostics declarations in the staging root. It is {} unless the build is a diagnostic build. */
/** The document in which the host provides the list of plugins installed in the configuration folder (installed plugin provision in docs/spec/installation.md). */
export const INSTALLED_PLUGINS = "installed-plugins.json";
/** The list of the core targets of the view import map in the staged frontend, written by the staging tool from viewCoreTargets. */
export const CORE_ROOT_FILE = "core-root.json";

/** The name prefix of the core entries that the surface document registers. The main document registers the other core entries. */
export const SURFACE_CORE = "core.surface.";

/** Returns a path inside the package as a path relative to the document root. */
export const modulePath = (name, path) => `modules/${name}/${path}`;

/** The kinds of the replay inputs, which `replay.inputs` of a sidecar.json maps to event names (docs/spec/replay.md#records). */
const REPLAY_KINDS = ["output", "write", "resize", "selection", "viewport", "theme"];

/** The imports of the import map that every page declares. A page has an import map equal to this value. */
export const PAGE_IMPORTS = Object.freeze({
  "soksak": `/${modulePath("soksak", "dist/index.js")}`,
  "@soksak/plugin-api": `/${modulePath("@soksak/plugin-api", "index.js")}`,
  "@soksak/plugin-api/page": `/${modulePath("@soksak/plugin-api", "page.js")}`,
  "@soksak/plugin-api/screen-hash": `/${modulePath("@soksak/plugin-api", "screen-hash.js")}`,
  "@soksak/runtime": `/${RUNTIME}/index.js`,
  "@soksak/shared/": "/shared/",
  "@soksak/workbench/": "/",
});

/**
 * The imports of the import map of a view page. A view is served from the core root (docs/spec/plugin-processes.md, rule 4),
 * so its import map names the core targets at sok://core, and it has no entry for runtime/ or the workbench.
 */
export const VIEW_IMPORTS = Object.freeze({
  "soksak": `sok://core/${modulePath("soksak", "dist/index.js")}`,
  "@soksak/plugin-api": `sok://core/${modulePath("@soksak/plugin-api", "index.js")}`,
  "@soksak/plugin-api/view": `sok://core/${modulePath("@soksak/plugin-api", "view.js")}`,
  "@soksak/shared/": "sok://core/shared/",
});

/** The entry files of the view import closure, by package name (docs/spec/plugin-processes.md, rule 4). */
const VIEW_CLOSURE_ENTRIES = Object.freeze({
  "@soksak/plugin-api": Object.freeze(["index.js", "view.js"]),
  "soksak": Object.freeze(["dist/index.js"]),
});

/** Returns the specifiers of the static imports, dynamic imports and re-exports of a module, without comments. */
function importSpecifiers(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const found = [];
  const pattern = /\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  // Each alternative of the pattern has one capture group; the group that did not match is undefined.
  for (const match of code.matchAll(pattern)) found.push(match.slice(1).find((group) => group !== undefined));
  return found;
}

/**
 * Returns the core root paths (`/modules/<package>/<file>`) of the files that the import closure of the view entries reaches,
 * sorted and without repeats. `read(name, file)` returns the source of a file of the package `name`, or undefined when the
 * package has no such file. A core target imports only relative paths inside its own package; any other import fails.
 * The staging tool writes the result to core-root.json, which each host reads as the list of its core targets.
 */
export function viewCoreTargets(read) {
  const reached = new Map();
  const pending = Object.entries(VIEW_CLOSURE_ENTRIES).flatMap(([name, files]) => files.map((file) => [name, file]));
  while (pending.length > 0) {
    const [name, file] = pending.shift();
    const key = `${name}/${file}`;
    if (reached.has(key)) continue;
    reached.set(key, `/${modulePath(name, file)}`);
    const source = read(name, file);
    if (source === undefined) throw new Error(`${key} is missing`);
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        throw new Error(`${key} imports ${specifier}, which a core target may not import`);
      }
      const target = joinInside(file, specifier);
      if (target === undefined) throw new Error(`${key} imports ${specifier}, which is outside the package`);
      const targetKey = `${name}/${target}`;
      if (!reached.has(targetKey)) {
        if (read(name, target) === undefined) throw new Error(`${key} imports ${specifier}, which is missing`);
        pending.push([name, target]);
      }
    }
  }
  return [...reached.values()].sort();
}

/** Joins a relative specifier to the directory of a file of a package. Returns undefined when the path leaves the package. */
function joinInside(file, specifier) {
  const parts = file.includes("/") ? file.slice(0, file.lastIndexOf("/")).split("/") : [];
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") {
      parts.push(part);
    } else if (parts.length > 0) {
      parts.pop();
    } else {
      return undefined;
    }
  }
  return parts.join("/");
}

/** Reads the import map object of an HTML document. Throws unless the document has exactly one import map. */
function importMap(html) {
  const maps = [...html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)];
  if (maps.length !== 1) throw new Error(`expected one import map, found ${maps.length}`);
  return JSON.parse(maps[0][1]);
}

/** Reads the imports of the import map from an HTML document. Throws unless the document has exactly one import map. */
export function pageImports(html) {
  return importMap(html).imports;
}

/**
 * Checks that a view page has exactly one static import map whose imports equal VIEW_IMPORTS, and that the map has no other
 * field, because a scopes field could remap the imports (docs/spec/plugins.md#view-surfaces). Returns nothing; throws an error
 * that names the first difference.
 */
export function checkViewPage(html) {
  const map = importMap(html);
  if (!isObject(map)) throw new Error("view page import map: expected an object");
  const field = Object.keys(map).find((key) => key !== "imports");
  if (field !== undefined) throw new Error(`view page import map: unexpected field ${JSON.stringify(field)}`);
  if (!isObject(map.imports)) throw new Error("view page import map: imports must be an object");
  for (const [key, target] of Object.entries(VIEW_IMPORTS)) {
    if (!Object.hasOwn(map.imports, key)) throw new Error(`view page import map: missing entry ${JSON.stringify(key)}`);
    if (map.imports[key] !== target) {
      throw new Error(
        `view page import map: entry ${JSON.stringify(key)} is ${JSON.stringify(map.imports[key])}, want ${JSON.stringify(target)}`,
      );
    }
  }
  const extra = Object.keys(map.imports).find((key) => !Object.hasOwn(VIEW_IMPORTS, key));
  if (extra !== undefined) throw new Error(`view page import map: unexpected entry ${JSON.stringify(extra)}`);
}

const ID = /^[a-z][a-z0-9-]*$/;
const PACKAGE = /^(@[a-z0-9-]+\/)?[a-z0-9-]+$/;
const REGION = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN = /^--[a-z][a-z0-9-]*$/;
const SETTING = /^[a-z][A-Za-z0-9-]*(?:\.[a-z][A-Za-z0-9-]*)*$/;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.length > 0;

const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** Compares two versions numerically. */
function compareVersion(a, b) {
  const [x, y] = [a, b].map((value) => value.split(".").map(Number));
  const part = x.findIndex((number, index) => number !== y[index]);
  return part === -1 ? 0 : x[part] - y[part];
}

/** Checks that the version range has the format of docs/spec/installation.md#versions-and-ranges. */
function isRange(range) {
  if (typeof range !== "string") return false;
  if (range === "*") return true;
  const bounded = /^>=(\S+) <(\S+)$/.exec(range);
  if (bounded) return VERSION.test(bounded[1]) && VERSION.test(bounded[2]) && compareVersion(bounded[1], bounded[2]) < 0;
  // `>=x.y.z` has a lower bound and no upper bound.
  const lower = /^>=(\S+)$/.exec(range);
  if (lower) return VERSION.test(lower[1]);
  return VERSION.test(range.replace(/^[\^~]/, ""));
}

/**
 * The operation names of a list that a plugin host may call on a sidecar: non-empty strings, each once
 * (docs/spec/plugins.md#pluginjson, hostOperations; docs/spec/sidecars.md, hostReadOperations).
 */
const isOperationList = (value) => Array.isArray(value) && value.length > 0
  && value.every((name) => isText(name)) && new Set(value).size === value.length;

/** Checks the plugin host declaration `host`: a page inside the package and an optional state declaration. */
function checkHost(where, host) {
  if (!isObject(host)) throw new Error(`${where}: host must be an object`);
  only(`${where} host`, host, ["page", "state"]);
  if (!isText(host.page) || host.page.startsWith("/") || host.page.split("/").includes("..")) {
    throw new Error(`${where}: host page must be a path inside the package`);
  }
  if (host.state !== undefined) {
    if (!isObject(host.state)) throw new Error(`${where}: host state must be an object`);
    only(`${where} host state`, host.state, ["format", "maxBytes"]);
    for (const key of ["format", "maxBytes"]) {
      if (!Number.isInteger(host.state[key]) || host.state[key] <= 0) throw new Error(`${where}: host state ${key} must be a positive integer`);
    }
  }
}

/**
 * Checks hostOperations: each sidecar dependency maps to the distinct operations its plugin host may call. A declaration
 * needs a plugin host, and each sidecar must be a dependency.
 */
function checkHostOperationsDeclaration(where, hostOperations, dependencies) {
  if (!isObject(hostOperations)) throw new Error(`${where}: hostOperations must map sidecars to operations`);
  for (const [name, operations] of Object.entries(hostOperations)) {
    if (!Object.hasOwn(dependencies, name)) throw new Error(`${where}: hostOperations ${name} is not a dependency`);
    if (!isOperationList(operations)) throw new Error(`${where}: hostOperations ${name} must be a list of distinct operation names`);
  }
}

/**
 * Checks that each operation a plugin host may call on a sidecar is one the sidecar declares in hostReadOperations, so a
 * host names only read operations. sidecars maps each sidecar name to its validated sidecar.json.
 */
export function checkHostOperations(manifest, sidecars) {
  // default: hostOperations is an optional field of plugin.json; without it the plugin host calls no operation of a sidecar.
  for (const [name, operations] of Object.entries(manifest.hostOperations ?? {})) {
    const sidecar = sidecars[name];
    if (sidecar === undefined) throw new Error(`hostOperations ${name}: sidecar.json is missing`);
    // default: hostReadOperations is an optional field of sidecar.json; without it the sidecar allows no operation to a plugin host.
    const readOperations = sidecar.hostReadOperations ?? [];
    for (const operation of operations) {
      if (!readOperations.includes(operation)) throw new Error(`hostOperations ${name}: operation ${operation} is not in hostReadOperations`);
    }
  }
}

/**
 * Checks the message form of a sidecar, which the body of a plugin host request takes (docs/spec/sidecars.md#messages). where names
 * the declaration that holds it.
 */
function checkSidecarMessage(where, message) {
  if (!isObject(message)) throw new Error(`${where}: message must be an object`);
  only(`${where} message`, message, ["form", "operationField"]);
  if (message.form !== "json-object") throw new Error(`${where}: message form must be json-object`);
  if (!isText(message.operationField) || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(message.operationField)) {
    throw new Error(`${where}: message operationField must be a field name`);
  }
}

/** Checks the list of operations that a sidecar allows a plugin host, hostReadOperations. where names the declaration that holds it. */
function checkHostReadOperations(where, operations) {
  if (!isOperationList(operations)) throw new Error(`${where}: hostReadOperations must be a list of distinct operation names`);
}

/**
 * Checks the sidecar facts of an installed plugin: each sidecar dependency maps to the message form and the host read operations of its
 * sidecar.json, which the installed document carries (docs/spec/installation.md). A name that is not a dependency is refused.
 */
function checkSidecarFacts(where, sidecars, dependencies) {
  if (!isObject(sidecars)) throw new Error(`${where}: sidecars must map sidecars to facts`);
  for (const [name, facts] of Object.entries(sidecars)) {
    if (!Object.hasOwn(dependencies, name)) throw new Error(`${where}: sidecars ${name} is not a dependency`);
    const sidecarWhere = `${where} sidecar ${name}`;
    if (!isObject(facts)) throw new Error(`${sidecarWhere}: facts must be an object`);
    only(sidecarWhere, facts, ["message", "hostReadOperations"]);
    if (facts.message !== undefined) checkSidecarMessage(sidecarWhere, facts.message);
    if (facts.hostReadOperations !== undefined) checkHostReadOperations(sidecarWhere, facts.hostReadOperations);
  }
}

/** Checks that dependencies give each sidecar or plugin a version range and returns their names. */
function checkDependencies(where, dependencies) {
  if (!isObject(dependencies)) throw new Error(`${where}: dependencies must map sidecars and plugins to version ranges`);
  for (const [name, range] of Object.entries(dependencies)) {
    if (!PACKAGE.test(name)) throw new Error(`${where}: dependencies: ${name} is not a sidecar or plugin name`);
    if (!isRange(range)) throw new Error(`${where}: dependencies ${name}: invalid range ${range}`);
  }
  return Object.keys(dependencies);
}

/**
 * The sidecars that the dependencies of plugin.json name. plugins holds the names of installed plugins; such a name
 * is a plugin dependency and is left out (docs/spec/plugins.md#pluginjson).
 */
export function manifestSidecars(manifest, plugins = new Set()) {
  // default: dependencies is an optional field of plugin.json; a plugin without it uses no sidecar.
  return Object.keys(manifest.dependencies ?? {}).filter((name) => !plugins.has(name));
}

/** Whether version is in range, a range of the form in docs/spec/installation.md#versions-and-ranges. */
export function rangeContains(range, version) {
  if (!isRange(range)) throw new Error(`invalid range ${range}`);
  if (!VERSION.test(version)) throw new Error(`invalid version ${version}`);
  if (range === "*") return true;
  const bounded = /^>=(\S+) <(\S+)$/.exec(range);
  if (bounded) return compareVersion(version, bounded[1]) >= 0 && compareVersion(version, bounded[2]) < 0;
  const lower = /^>=(\S+)$/.exec(range);
  if (lower) return compareVersion(version, lower[1]) >= 0;
  const operator = /^[\^~]/.test(range) ? range[0] : "";
  const [major, minor, patch] = range.slice(operator.length).split(".").map(Number);
  const low = `${major}.${minor}.${patch}`;
  const below = operator === "" ? `${major}.${minor}.${patch + 1}`
    : operator === "~" ? `${major}.${minor + 1}.0`
    : major > 0 ? `${major + 1}.0.0` : minor > 0 ? `0.${minor + 1}.0` : `0.0.${patch + 1}`;
  return compareVersion(version, low) >= 0 && compareVersion(version, below) < 0;
}

/**
 * Resolves the contributions of the installed and enabled plugins ({id, package, version, manifest})
 * (docs/spec/plugins.md#extension-points). Each item is {plugin, point, index, state, reason}; a connected item also has
 * provider, item (the fields without range and module) and module (a URL). Items are sorted by plugin id, point and index.
 */
export function resolveContributions(installed) {
  const providers = new Map(installed.map((plugin) => [plugin.id, plugin]));
  const resolved = [];
  for (const plugin of [...installed].sort((a, b) => a.id.localeCompare(b.id))) {
    // default: contributes is an optional field of plugin.json; a plugin without it contributes nothing.
    for (const [point, items] of Object.entries(plugin.manifest.contributes ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      const [providerId, name] = [point.slice(0, point.indexOf(".")), point.slice(point.indexOf(".") + 1)];
      const provider = providers.get(providerId);
      // default: extends is an optional field; a plugin without it declares no extension point.
      const declaration = provider?.manifest.extends?.[name];
      items.forEach((entry, index) => {
        const base = { plugin: plugin.id, point, index };
        const { range, module, ...item } = entry;
        if (!provider) return resolved.push({ ...base, state: "provider-missing", reason: `plugin ${providerId} is not installed or not enabled` });
        if (!declaration) return resolved.push({ ...base, state: "invalid", reason: `${providerId} ${provider.version} declares no extension point ${name}` });
        if (!rangeContains(range, declaration.version)) {
          return resolved.push({ ...base, state: "version-mismatch", reason: `range ${range} does not contain ${point} ${declaration.version}` });
        }
        if (!matchesSchema(declaration.schema, item)) return resolved.push({ ...base, state: "invalid", reason: `item does not match the schema of ${point}` });
        resolved.push({ ...base, state: "connected", reason: null, provider: providerId, item, module: `/${modulePath(plugin.package, module)}` });
      });
    }
  }
  return resolved;
}

function only(where, value, keys) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${where}: unknown field ${key}`);
  }
}

/* The maximum length of the plugin description that the settings window shows. */
const PLUGIN_DESCRIPTION_MAX = 200;

/* The maximum length of the setting name and description that the settings window shows. */
const SETTING_LABEL_MAX = 40;
const SETTING_DESCRIPTION_MAX = 200;
const ADDRESS_MAX = 2048;

/** Address setting value: an empty string or an http or https address of at most 2048 characters. */
export function isSettingAddress(value) {
  return value === "" || (typeof value === "string" && value.length <= ADDRESS_MAX && /^https?:\/\/[^/]/i.test(value));
}

function checkSettingDeclaration(where, full) {
  if (!isObject(full)) throw new Error(`${where}: setting must be an object`);
  // The settings window shows label as the row name and description as the explanation below it.
  const { label, description, ...declaration } = full;
  if (typeof label !== "string" || label.length < 1 || label.length > SETTING_LABEL_MAX) {
    throw new Error(`${where}: label must be 1 to ${SETTING_LABEL_MAX} characters`);
  }
  if (description !== undefined &&
      (typeof description !== "string" || description.length < 1 || description.length > SETTING_DESCRIPTION_MAX)) {
    throw new Error(`${where}: description must be 1 to ${SETTING_DESCRIPTION_MAX} characters`);
  }
  if (declaration.type === "enum") {
    only(where, declaration, ["type", "default", "values"]);
    if (!Array.isArray(declaration.values) || declaration.values.length === 0 ||
        declaration.values.some((value) => typeof value !== "string" || value.length === 0) ||
        new Set(declaration.values).size !== declaration.values.length) {
      throw new Error(`${where}: enum values must be distinct non-empty strings`);
    }
    if (!declaration.values.includes(declaration.default)) {
      throw new Error(`${where}: default must be one of values`);
    }
    return;
  }
  if (declaration.type === "integer") {
    only(where, declaration, ["type", "default", "minimum", "maximum"]);
    if (!Number.isInteger(declaration.default) || !Number.isInteger(declaration.minimum) ||
        !Number.isInteger(declaration.maximum) || declaration.minimum > declaration.maximum ||
        declaration.default < declaration.minimum || declaration.default > declaration.maximum) {
      throw new Error(`${where}: integer default and bounds are invalid`);
    }
    return;
  }
  if (declaration.type === "string") {
    only(where, declaration, ["type", "default", "maxLength"]);
    if (!Number.isInteger(declaration.maxLength) || declaration.maxLength < 1 ||
        typeof declaration.default !== "string" || declaration.default.length === 0 ||
        declaration.default.length > declaration.maxLength) {
      throw new Error(`${where}: string default and maxLength are invalid`);
    }
    return;
  }
  if (declaration.type === "address") {
    only(where, declaration, ["type", "default"]);
    if (!isSettingAddress(declaration.default)) {
      throw new Error(`${where}: address default must be empty or an http or https address`);
    }
    return;
  }
  throw new Error(`${where}: setting type must be enum, integer, string, or address`);
}

function checkSettings(where, settings) {
  if (settings === undefined) return;
  if (!isObject(settings)) throw new Error(`${where}: settings must be an object`);
  for (const [key, declaration] of Object.entries(settings)) {
    if (!SETTING.test(key)) throw new Error(`${where}: invalid setting name ${key}`);
    checkSettingDeclaration(`${where}.${key}`, declaration);
  }
}

function checkSettingValue(where, declaration, value) {
  if (declaration.type === "enum" && !declaration.values.includes(value)) {
    throw new Error(`${where}: value is not declared`);
  }
  if (declaration.type === "integer" &&
      (!Number.isInteger(value) || value < declaration.minimum || value > declaration.maximum)) {
    throw new Error(`${where}: integer value is outside its declared range`);
  }
  if (declaration.type === "string" &&
      (typeof value !== "string" || value.length === 0 || value.length > declaration.maxLength)) {
    throw new Error(`${where}: string value must be non-empty and at most ${declaration.maxLength} characters`);
  }
  if (declaration.type === "address" && !isSettingAddress(value)) {
    throw new Error(`${where}: address value must be empty or an http or https address`);
  }
}

export function settingDeclarations(manifest) {
  // default: settings is an optional field of plugin.json; a plugin without it has no settings.
  return Object.fromEntries(Object.entries(manifest.settings ?? {}).map(([key, declaration]) => [
    `${manifest.id}.${key}`, { ...declaration, plugin: manifest.id, key },
  ]));
}

/** The page of a view is a path inside the plugin release: relative, no empty, `.` or `..` segment, no `.binary` segment, ending in `.html`. */
const isViewPage = (page) => isText(page) && page.endsWith(".html") &&
  page.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && segment !== ".binary");

/** Validates the surface composition declaration. This declaration is the host's list of region permissions. */
function checkComposition(where, composition, sidecars) {
  if (!isObject(composition)) throw new Error(`${where}: composition must be an object`);
  if (composition.kind === "dom") {
    throw new Error(`${where} composition: kind dom is removed; the composition takes kind view or hybrid`);
  }
  if (composition.kind === "view") {
    only(`${where} composition`, composition, ["kind", "page", "regions", "overlays"]);
    if (composition.page === undefined) throw new Error(`${where} composition: view composition requires page`);
    if (!isViewPage(composition.page)) {
      throw new Error(`${where} composition: page must be a path inside the plugin release that ends in .html`);
    }
    if (composition.regions !== undefined && (!Array.isArray(composition.regions) || composition.regions.length === 0)) {
      throw new Error(`${where} composition: regions must be a non-empty array`);
    }
    if (composition.overlays !== undefined && !Array.isArray(composition.overlays)) {
      throw new Error(`${where} composition: overlays must be an array`);
    }
    // default: regions and overlays are optional in a view; a view without them declares no native region or overlay.
    checkRegions(where, composition.regions ?? [], composition.overlays ?? [], sidecars);
    return;
  }
  if (composition.kind !== "hybrid") throw new Error(`${where}: composition kind must be hybrid or view`);
  only(`${where} composition`, composition, ["kind", "regions", "overlays"]);
  if (!Array.isArray(composition.regions) || composition.regions.length === 0) {
    throw new Error(`${where}: hybrid composition requires regions`);
  }
  if (!Array.isArray(composition.overlays)) throw new Error(`${where}: hybrid composition requires overlays`);
  checkRegions(where, composition.regions, composition.overlays, sidecars);
}

/** Validates the regions and overlays of a hybrid or view composition; the names of both are unique. */
function checkRegions(where, regions, overlays, sidecars) {
  const names = new Set();
  for (const region of regions) {
    if (!isObject(region)) throw new Error(`${where} composition region: expected an object`);
    if (typeof region.name !== "string" || !REGION.test(region.name)) {
      throw new Error(`${where} composition: invalid region name ${region.name}`);
    }
    if (names.has(region.name)) throw new Error(`${where} composition: duplicate name ${region.name}`);
    names.add(region.name);
    const regionWhere = `${where} composition region ${region.name}`;
    if (region.kind === "document") {
      only(regionWhere, region, ["name", "kind", "input"]);
      if (region.input !== "native") throw new Error(`${regionWhere}: document input must be native`);
      continue;
    }
    if (region.kind === "image") {
      only(regionWhere, region, ["name", "kind", "sidecar", "input"]);
      if (region.input !== "dom") throw new Error(`${regionWhere}: image input must be dom`);
      if (typeof region.sidecar !== "string" || !sidecars.includes(region.sidecar)) {
        throw new Error(`${regionWhere}: sidecar must be declared by the plugin`);
      }
      continue;
    }
    throw new Error(`${regionWhere}: kind must be document or image`);
  }
  for (const overlay of overlays) {
    if (typeof overlay !== "string" || !REGION.test(overlay)) {
      throw new Error(`${where} composition: invalid overlay name ${overlay}`);
    }
    if (names.has(overlay)) throw new Error(`${where} composition: duplicate name ${overlay}`);
    names.add(overlay);
  }
}

function checkBackground(where, background, sidecars, settings = {}) {
  if (!isObject(background)) throw new Error(`${where}: background must be an object`);
  only(`${where} background`, background, ["sidecar", "operation", "settings"]);
  // settings maps a request field name to a setting name that this plugin declares. When the core opens a session, it puts the value
  // of that setting into the request field.
  if (background.settings !== undefined) {
    if (!isObject(background.settings)) throw new Error(`${where} background: settings must map request fields to setting names`);
    for (const [field, setting] of Object.entries(background.settings)) {
      if (field === "operation") throw new Error(`${where} background: a setting cannot replace operation`);
      // default: settings is an optional field of plugin.json; for a plugin without it, background has no setting to point to.
      if (typeof setting !== "string" || !Object.hasOwn(settings ?? {}, setting)) {
        throw new Error(`${where} background: setting ${setting} is not declared by the plugin`);
      }
    }
  }
  if (typeof background.sidecar !== "string" || !sidecars.includes(background.sidecar)) {
    throw new Error(`${where} background: sidecar must be declared by the plugin`);
  }
  if (typeof background.operation !== "string" || background.operation.length === 0) {
    throw new Error(`${where} background: operation must be a non-empty string`);
  }
}


/** Whether path is the path of a JavaScript file inside the package. */
function isModulePath(path) {
  return isText(path) && !path.startsWith("/") && !path.split("/").includes("..") && path.endsWith(".js");
}

// A bare specifier is a package name that is not a relative path, an absolute path or a URL, together with its subpath.
const BARE = /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*(\/[A-Za-z0-9._-]+)*$/;

/** Validates the extension point declaration of a provider (docs/spec/plugins.md#extension-points). */
function checkExtends(where, points) {
  if (!isObject(points)) throw new Error(`${where}: extends must be an object`);
  for (const [name, point] of Object.entries(points)) {
    if (!ID.test(name)) throw new Error(`${where}: invalid extension point ${name}`);
    const at = `${where} extension point ${name}`;
    if (!isObject(point)) throw new Error(`${at}: must be an object`);
    only(at, point, ["version", "schema", "modules"]);
    if (typeof point.version !== "string" || !VERSION.test(point.version)) throw new Error(`${at} version must be x.y.z`);
    checkSchema(`${at} schema`, point.schema);
    if (point.modules !== undefined) {
      if (!isObject(point.modules)) throw new Error(`${at}: modules must be an object`);
      for (const [specifier, path] of Object.entries(point.modules)) {
        if (!BARE.test(specifier)) throw new Error(`${at} module ${specifier} is not a bare specifier`);
        if (!isModulePath(path)) throw new Error(`${at} module ${specifier} must be a JavaScript path inside the package`);
      }
    }
  }
}

/** Validates the contribution declaration of a contributor. The workbench validates the schema field of an entry with the declaration of the provider. */
function checkContributes(where, id, contributes) {
  if (!isObject(contributes)) throw new Error(`${where}: contributes must be an object`);
  for (const [name, items] of Object.entries(contributes)) {
    const dot = name.indexOf(".");
    if (dot < 0 || !ID.test(name.slice(0, dot)) || !ID.test(name.slice(dot + 1))) {
      throw new Error(`${where}: contributes ${name} must be <plugin id>.<point>`);
    }
    if (name.slice(0, dot) === id) throw new Error(`${where}: contributes to its own extension point ${name}`);
    if (!Array.isArray(items) || items.length === 0) throw new Error(`${where}: contributes ${name} must be a non-empty array`);
    items.forEach((item, index) => {
      const at = `${where}: contributes ${name} item ${index + 1}`;
      if (!isObject(item)) throw new Error(`${at} must be an object`);
      if (!isRange(item.range)) throw new Error(`${at} range ${item.range} is invalid`);
      if (!isModulePath(item.module)) throw new Error(`${at} module must be a JavaScript path inside the package`);
    });
  }
}

/**
 * Validates one plugin.json. Throws when the format is wrong and returns the received value otherwise.
 *
 *     id        plugin id. Tabs and settings refer to this value
 *     name      name shown on the screen
 *     mark      short mark shown in the `+` menu and in the tab title. Required when surface exists
 *     icon      SVG element with a 16×16 view box. Required when surface exists
 *     surface   card surface. `{ page, composition }` declares the document inside the plugin and the composition permissions
 *     sections  sections that the sidebar can show. The id has the form `<plugin id>.<name>`
 *     preview   colors of the library preview. `ink` is a theme token name (`--rail` and others). surface must exist
 *   dependencies  the version range of each sidecar that the page surface or the plugin host uses and of each plugin that it contributes to
 *     exposes   status, command and dom entries that the surface page registers. A page surface must exist
 */
// The path segment that the binary store of a document region answers before it looks up a file
// (docs/spec/native-surfaces.md#document-regions), so a plugin file under it could not be served.
const BINARY_SEGMENT = ".binary";

/** Returns the files of a plugin package.json, and throws for a file whose path has a .binary segment. */
export function validateReleaseFiles(pkg) {
  if (!Array.isArray(pkg.files)) throw new Error("package.json files: expected an array");
  for (const file of pkg.files) {
    if (file.split("/").includes(BINARY_SEGMENT)) {
      throw new Error(`plugin release lists ${file}: the ${BINARY_SEGMENT} path is reserved for the binary store`);
    }
  }
  return pkg.files;
}

export function validateManifest(manifest) {
  if (!isObject(manifest)) throw new Error("plugin.json: expected an object");
  // The state module is removed: its project data moves to the plugin host (docs/spec/plugins.md#project-data).
  if (isObject(manifest) && manifest.state !== undefined) {
    throw new Error(`plugin ${manifest.id}: state is removed; a plugin keeps project data through its host (docs/spec/plugins.md#project-data)`);
  }
  only("plugin.json", manifest, ["id", "name", "description", "mark", "icon", "surface", "sections", "preview", "dependencies", "background", "exposes", "settings",
    "data", "sidebars", "extends", "contributes", "events", "host", "hostOperations"]);
  validateEventsPath("plugin.json", manifest.events);
  const { id } = manifest;
  if (typeof id !== "string" || !ID.test(id)) throw new Error(`plugin.json: invalid id ${id}`);
  // The core root is the reserved host `core` (docs/spec/plugin-processes.md rule 4), so no plugin may take that id.
  if (id === "core") throw new Error("plugin.json: plugin id core is reserved for the core root");
  const where = `plugin ${id}`;
  if (!isText(manifest.name)) throw new Error(`${where}: name is required`);
  // The plugin list of the settings window shows the description and searches it.
  if (typeof manifest.description !== "string" || manifest.description.length < 1 ||
      manifest.description.length > PLUGIN_DESCRIPTION_MAX) {
    throw new Error(`${where}: description must be 1 to ${PLUGIN_DESCRIPTION_MAX} characters`);
  }
  if (manifest.data !== undefined) {
    // The plugin host serves project data (docs/spec/plugins.md#project-data).
    if (manifest.host === undefined) throw new Error(`${where}: data requires a plugin host`);
    if (!isObject(manifest.data)) throw new Error(`${where}: data must be an object`);
    for (const [key, entry] of Object.entries(manifest.data)) {
      if (!ID.test(key)) throw new Error(`${where}: invalid data key ${key}`);
      if (!isObject(entry) || !isObject(entry.schema) || !Object.hasOwn(entry, "default")) {
        throw new Error(`${where}: data ${key} requires schema and default`);
      }
      only(`${where} data ${key}`, entry, ["schema", "default", "format"]);
      if (!matchesSchema(entry.schema, entry.default)) throw new Error(`${where}: data ${key} default does not match its schema`);
      if (Object.hasOwn(entry, "format") && !(Number.isInteger(entry.format) && entry.format > 0)) {
        throw new Error(`${where}: data ${key} format must be a positive integer`);
      }
    }
  }
  if (manifest.dependencies !== undefined) {
    // A sidecar dependency serves the surface or the plugin host, and a plugin dependency serves the contributions
    // (docs/spec/plugins.md#pluginjson).
    if (manifest.surface === undefined && manifest.host === undefined && manifest.contributes === undefined) {
      throw new Error(`${where}: dependencies require a surface, a plugin host or contributes`);
    }
    checkDependencies(where, manifest.dependencies);
  }
  if (manifest.host !== undefined) checkHost(where, manifest.host);
  if (manifest.hostOperations !== undefined) {
    // A plugin host calls the operations that its manifest declares for each sidecar dependency (docs/spec/plugin-host.md).
    if (manifest.host === undefined) throw new Error(`${where}: hostOperations requires host`);
    // default: dependencies is an optional field of plugin.json; without it the plugin has no sidecar that hostOperations may name.
    checkHostOperationsDeclaration(where, manifest.hostOperations, manifest.dependencies ?? {});
  }
  if (manifest.extends !== undefined) {
    if (manifest.surface === undefined) throw new Error(`${where}: extends requires a surface`);
    checkExtends(where, manifest.extends);
  }
  if (manifest.contributes !== undefined) checkContributes(where, id, manifest.contributes);
  if (manifest.background !== undefined) {
    if (manifest.surface === undefined) throw new Error(`${where}: background requires a surface`);
    checkBackground(`${where}`, manifest.background, manifestSidecars(manifest), manifest.settings);
  }
  if (manifest.surface !== undefined) {
    const surface = manifest.surface;
    if (!isObject(surface)) throw new Error(`${where}: surface must be an object`);
    only(`${where} surface`, surface, ["module", "composition", "drop", "params", "opens", "save", "menu", "unload"]);
    // The context menu of the surface (docs/spec/plugins.md#pluginjson).
    if (surface.menu !== undefined) {
      if (!Array.isArray(surface.menu) || surface.menu.length === 0 || surface.menu.length > 16) {
        throw new Error(`${where}: surface menu must be an array of 1 to 16 items`);
      }
      const seen = new Set();
      for (const item of surface.menu) {
        if (!isObject(item)) throw new Error(`${where}: a surface menu item must be an object`);
        only(`${where} surface menu item`, item, ["command", "title"]);
        // default: exposes and its commands are optional; a plugin without declared commands has no menu command.
        if (!isText(item.command) || !(manifest.exposes?.commands ?? []).some((command) => command.name === item.command)) {
          throw new Error(`${where}: surface menu command ${item.command} must name a command declared in exposes`);
        }
        if (seen.has(item.command)) throw new Error(`${where}: surface menu command ${item.command} is repeated`);
        seen.add(item.command);
        if (typeof item.title !== "string" || item.title.length < 1 || item.title.length > 40) {
          throw new Error(`${where}: surface menu title of ${item.command} must be 1 to 40 characters`);
        }
      }
    }
    // The command that saves the surface's changes before a modified tab closes (docs/spec/plugins.md#tab-reports).
    if (surface.save !== undefined && (!isText(surface.save) ||
      // default: exposes and its commands are optional; a plugin without declared commands has no save command.
      !(manifest.exposes?.commands ?? []).some((command) => command.name === surface.save))) {
      throw new Error(`${where}: surface save must name a command declared in exposes`);
    }
    // The parameters of a tab of the plugin (docs/spec/plugins.md#pluginjson).
    if (surface.params !== undefined) {
      if (!isObject(surface.params) || surface.params.type !== "object") {
        throw new Error(`${where}: surface params must be a schema of type object`);
      }
      checkSchema(`${where} surface params`, surface.params);
    }
    // The files that the plugin opens with core.file.open (docs/spec/plugins.md#pluginjson).
    if (surface.opens !== undefined) {
      if (!isObject(surface.opens)) throw new Error(`${where}: surface opens must be an object`);
      only(`${where} surface opens`, surface.opens, ["extensions"]);
      if (surface.params?.properties?.path?.type !== "string") {
        throw new Error(`${where}: surface opens requires surface params with a string property path`);
      }
      const { extensions } = surface.opens;
      if (!Array.isArray(extensions) || extensions.length === 0) throw new Error(`${where}: surface opens extensions must be a non-empty array`);
      const seen = new Set();
      for (const extension of extensions) {
        if (extension !== "*" && !(typeof extension === "string" && /^[a-z0-9]+$/.test(extension))) {
          throw new Error(`${where}: surface opens extension ${extension} must be * or lowercase letters and digits`);
        }
        if (seen.has(extension)) throw new Error(`${where}: surface opens extension ${extension} is repeated`);
        seen.add(extension);
      }
    }
    // The drop command is a declared command that the page runs on a surface with {urls} when files are dropped on that surface.
    if (surface.drop !== undefined && (!isText(surface.drop) ||
      // default: exposes and its commands are optional fields; a plugin that declares no command has no drop command.
      !(manifest.exposes?.commands ?? []).some((command) => command.name === surface.drop))) {
      throw new Error(`${where}: surface drop must name a command declared in exposes`);
    }
    // A view surface has no module: its page is declared in the composition (docs/spec/plugins.md#view-surfaces).
    const view = isObject(surface.composition) && surface.composition.kind === "view";
    if (view && surface.module !== undefined) throw new Error(`${where}: surface module is refused beside a view composition`);
    if (!view) {
      if (!isText(surface.module)) throw new Error(`${where}: surface requires a module`);
      if (surface.module.startsWith("/") || surface.module.split("/").includes("..") || !surface.module.endsWith(".js")) {
        throw new Error(`${where}: surface module must be a JavaScript path inside the package`);
      }
    }
    if (surface.composition === undefined) throw new Error(`${where}: surface requires a composition`);
    checkComposition(`${where} surface`, surface.composition, manifestSidecars(manifest));
    // surface.unload is absent (the tabs are never unloaded, undeclared) or {format, maxBytes} (docs/spec/plugins.md#memory-saver).
    if (manifest.background !== undefined) {
      if (surface.unload !== undefined) throw new Error(`${where}: surface unload is forbidden beside background`);
    } else if (surface.unload !== undefined) {
      const unload = surface.unload;
      if (!isObject(unload) || !Number.isInteger(unload.format) || unload.format < 1 ||
          !Number.isInteger(unload.maxBytes) || unload.maxBytes < 1) {
        throw new Error(`${where}: surface unload must be {format, maxBytes} with positive integers`);
      }
      only(`${where} surface unload`, unload, ["format", "maxBytes"]);
    }
    if (!isText(manifest.mark)) throw new Error(`${where}: mark is required with a surface`);
    if (!isText(manifest.icon)) throw new Error(`${where}: icon is required with a surface`);
  }
  if (manifest.sections !== undefined) {
    if (!Array.isArray(manifest.sections)) throw new Error(`${where}: sections must be an array`);
    const seen = new Set();
    // A status backs at most one section (docs/spec/declared-ui.md, sidebar section form).
    const backing = new Map();
    for (const section of manifest.sections) {
      if (!isObject(section)) throw new Error(`${where}: section must be an object`);
      // The module section is removed: a section draws its declared status (docs/spec/declared-ui.md, sidebar section form).
      if (section.module !== undefined) {
        throw new Error(`${where}: section ${section.id} module is removed; a section takes status (docs/spec/declared-ui.md)`);
      }
      only(`${where} section`, section, ["id", "name", "fill", "status"]);
      if (typeof section.id !== "string" || !section.id.startsWith(`${id}.`) || !ID.test(section.id.slice(id.length + 1))) {
        throw new Error(`${where}: section id ${section.id} must be ${id}.<name>`);
      }
      if (seen.has(section.id)) throw new Error(`${where}: duplicate section ${section.id}`);
      seen.add(section.id);
      if (!isText(section.name)) throw new Error(`${where}: section ${section.id} requires a name`);
      if (section.status === undefined) throw new Error(`${where}: section ${section.id} requires a status`);
      const declared = Array.isArray(manifest.exposes?.status) && manifest.exposes.status.some((entry) => entry?.name === section.status);
      if (!declared) throw new Error(`${where}: section ${section.id} status ${section.status} is not a status of plugin ${id}`);
      if (backing.has(section.status)) {
        throw new Error(`${where}: status ${section.status} backs section ${backing.get(section.status)} and section ${section.id}`);
      }
      backing.set(section.status, section.id);
      // fill is the section that receives the remaining height in the list layout (docs/spec/plugins.md#sections).
      if (section.fill !== undefined && typeof section.fill !== "boolean") {
        throw new Error(`${where}: section ${section.id} fill must be a boolean`);
      }
    }
  }
  if (manifest.preview !== undefined) {
    if (manifest.surface === undefined) throw new Error(`${where}: preview requires a surface`);
    if (!isObject(manifest.preview)) throw new Error(`${where}: preview must be an object`);
    only(`${where} preview`, manifest.preview, ["ink"]);
    if (typeof manifest.preview.ink !== "string" || !TOKEN.test(manifest.preview.ink)) {
      throw new Error(`${where}: preview.ink must be a theme token name`);
    }
  }
  if (manifest.exposes !== undefined) {
    // A plugin host registers the declared statuses and commands of its plugin (docs/spec/plugin-host.md#exposure).
    if (manifest.surface === undefined && manifest.host === undefined) {
      throw new Error(`${where}: exposes require a surface or a plugin host`);
    }
    validateExposes(id, manifest.exposes);
  }
  checkSettings(`${where}`, manifest.settings);
  if (manifest.surface === undefined && manifest.sections === undefined && manifest.contributes === undefined) {
    throw new Error(`${where}: a plugin requires a surface, sections or contributes`);
  }
  if (manifest.sidebars !== undefined) validatePluginSidebarDefaults(manifest);
  return manifest;
}

/**
 * Validates one project data value of the plugin with the declared data and returns the value.
 * Throws when the key is not declared or the value does not match the schema (docs/spec/plugins.md#project-data).
 */
export function checkProjectData(plugin, data, key, value) {
  const entry = data?.[key];
  if (!entry) throw new Error(`${plugin} data ${key} is not declared`);
  if (!matchesSchema(entry.schema, value)) throw new Error(`${plugin} data ${key} does not match its schema`);
  return value;
}

/**
 * Validates one sidecar.json. Throws when the format is wrong and returns the received value otherwise.
 *
 *     executable  path of the built executable inside the sidecar. The native host looks for this file name
 *                             in the same directory as the application executable
 *     protocol    message format version. Currently 1
 *   helpers     optional; the helper programs of the sidecar, each with the name of its package.json and its executable
 */
/**
 * `events` of a manifest names the file of the event catalog of the package, a path inside the package like `executable`
 * (docs/spec/logging.md#catalog). It is optional.
 */
function validateEventsPath(where, events) {
  if (events === undefined) return;
  if (!isText(events) || events.startsWith("/") || events.split("/").includes("..")) {
    throw new Error(`${where}: events must be a path inside the package`);
  }
}

export function validateSidecar(sidecar) {
  if (!isObject(sidecar)) throw new Error("sidecar.json: expected an object");
  only("sidecar.json", sidecar, ["executable", "protocol", "helpers", "transport", "events", "replay", "message", "hostReadOperations"]);
  // The message form that a plugin host's body takes; the host parses the body in this form (docs/spec/sidecars.md#messages).
  if (sidecar.message !== undefined) checkSidecarMessage("sidecar.json", sidecar.message);
  if (sidecar.hostReadOperations !== undefined) checkHostReadOperations("sidecar.json", sidecar.hostReadOperations);
  validateEventsPath("sidecar.json", sidecar.events);
  const { executable } = sidecar;
  if (!isText(executable) || executable.startsWith("/") || executable.split("/").includes("..")) {
    throw new Error("sidecar.json: executable must be a path inside the package");
  }
  if (sidecar.protocol !== 1) throw new Error("sidecar.json: protocol must be 1");
  if (sidecar.transport !== undefined && sidecar.transport !== "persistent") {
    throw new Error("sidecar.json: transport must be persistent");
  }
  if (sidecar.replay !== undefined) {
    const { replay } = sidecar;
    if (!isObject(replay)) throw new Error("sidecar.json: replay must be an object");
    only("sidecar.json replay", replay, ["role", "executable", "inputs"]);
    if (typeof replay.role !== "string" || !/^[a-z][a-z0-9]*$/.test(replay.role)) {
      throw new Error("sidecar.json replay: role must be a lowercase word");
    }
    const path = replay.executable;
    if (!isText(path) || path.startsWith("/") || path.split("/").includes("..")) {
      throw new Error("sidecar.json replay: executable must be a path inside the package");
    }
    // The kind of a replay input is the sidecar's choice of event name (docs/spec/replay.md#records), so the sidecar names it.
    if (!isObject(replay.inputs)) throw new Error("sidecar.json replay: inputs must be an object that names the event of each kind");
    only("sidecar.json replay inputs", replay.inputs, REPLAY_KINDS);
    for (const kind of REPLAY_KINDS) {
      const name = replay.inputs[kind];
      if (!isText(name) || !/^sidecar\.[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(name)) {
        throw new Error(`sidecar.json replay inputs: ${kind} must be the name of an event of the layer sidecar, found ${JSON.stringify(name)}`);
      }
    }
  }
  if (sidecar.helpers !== undefined) {
    if (!Array.isArray(sidecar.helpers)) throw new Error("sidecar.json: helpers must be an array");
    // The host looks for the executable by file name, so one sidecar cannot require the same name twice.
    const names = new Set([executable.split("/").pop()]);
    for (const helper of sidecar.helpers) {
      if (!isObject(helper)) throw new Error("sidecar.json helpers: expected an object");
      only("sidecar.json helpers", helper, ["name", "executable"]);
      if (!isText(helper.name) || !PACKAGE.test(helper.name)) {
        throw new Error("sidecar.json helpers: name must be a package.json name");
      }
      const path = helper.executable;
      if (!isText(path) || path.startsWith("/") || path.split("/").includes("..")) {
        throw new Error("sidecar.json helpers: executable must be a path inside the helper folder");
      }
      const file = path.split("/").pop();
      if (names.has(file)) throw new Error(`sidecar.json helpers: ${file} is declared twice`);
      names.add(file);
    }
  }
  return sidecar;
}

/**
 * Validates one environment.json. Throws when the format is wrong and returns the received value otherwise.
 *
 *     runtime    runtime module directory. A path relative to the application directory that contains index.js
 *     workspace  layout of a new space. focus is the id of the card to focus, grid holds the lines and cards
 *     sidebars   defaults of the sidebar sets (sets) and the slot links (links)
 *
 * Plugins come from the list installed in the configuration folder, not from environment.json (validateInstalledPlugins). References to plugin ids and
 * section ids are validated with checkReferences after the manifests are loaded.
 */
export function validateEnvironment(environment) {
  if (!isObject(environment)) throw new Error("environment.json: expected an object");
  only("environment.json", environment, ["runtime", "workspace", "sidebars", "settings", "sidecars", "starter", "install", "registry"]);
  if (environment.sidecars !== undefined && typeof environment.sidecars !== "boolean") {
    throw new Error("environment.json: sidecars must be true or false");
  }
  if (environment.starter !== undefined && !isText(environment.starter)) {
    throw new Error("environment.json: starter must be a pack name");
  }
  if (environment.install !== undefined && !isText(environment.install)) {
    throw new Error("environment.json: install must be a pack name");
  }
  // The default registry is the index location that the first run determines (docs/spec/installation.md#fetching).
  if (environment.registry !== undefined
    && !(isText(environment.registry) && /^(https:\/\/[^/?#]+|file:\/\/\/)/.test(environment.registry))) {
    throw new Error("environment.json: registry must be an https: or absolute file: URL");
  }
  if (!isText(environment.runtime) || environment.runtime.startsWith("/") || environment.runtime.split("/").includes("..")) {
    throw new Error("environment.json: runtime must be a directory inside the application");
  }
  if (environment.settings !== undefined && !isObject(environment.settings)) {
    throw new Error("environment.json: settings must be an object");
  }
  const { workspace } = environment;
  if (!isObject(workspace)) throw new Error("environment.json: workspace is required");
  only("environment.json workspace", workspace, ["focus", "grid"]);
  const { grid } = workspace;
  if (!isObject(grid) || !Array.isArray(grid.xs) || !Array.isArray(grid.ys) || !Array.isArray(grid.cards)) {
    throw new Error("environment.json: workspace.grid requires xs, ys, and cards");
  }
  only("environment.json workspace.grid", grid, ["xs", "ys", "cards"]);
  for (const card of grid.cards) {
    if (!isObject(card) || !isText(card.id)) throw new Error("environment.json: every card requires an id");
    only(`environment.json card ${card.id}`, card, ["id", "c0", "c1", "r0", "r1", "width", "fixed", "tabs"]);
    if (card.width !== undefined && !(Number.isFinite(card.width) && card.width > 0)) {
      throw new Error(`environment.json: card ${card.id} width must be a finite positive number`);
    }
    if (card.tabs !== undefined) {
      if (!Array.isArray(card.tabs) || card.tabs.length === 0) {
        throw new Error(`environment.json: card ${card.id} tabs must be a non-empty array`);
      }
      for (const tab of card.tabs) {
        if (!isObject(tab) || !isText(tab.plugin) || !isText(tab.title)) {
          throw new Error(`environment.json: card ${card.id} tabs require plugin and title`);
        }
        only(`environment.json card ${card.id} tab`, tab, ["plugin", "title"]);
      }
    }
  }
  if (!grid.cards.some((card) => card.id === workspace.focus && card.tabs)) {
    throw new Error("environment.json: workspace.focus must name a card with tabs");
  }
  if (environment.sidebars !== undefined) validateSidebars(environment.sidebars, "environment.json");
  return environment;
}

/**
 * Checks that the plugin ids and section ids that environment.json references exist in the loaded manifests.
 * Throws when one does not.
 */
export function checkReferences(environment, manifests) {
  const cards = new Set(manifests.filter((m) => m.surface).map((m) => m.id));
  const ids = manifests.map((m) => m.id);
  if (new Set(ids).size !== ids.length) throw new Error("environment.json: two plugins declare the same id");
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  // default: settings is an optional field of environment.json; without it, the plugin setting defaults are not changed.
  for (const [pluginId, values] of Object.entries(environment.settings ?? {})) {
    const manifest = byId.get(pluginId);
    // The settings of a plugin that is not loaded are kept; they are neither validated nor applied (docs/spec/plugins.md).
    if (!manifest) continue;
    if (!isObject(values)) throw new Error(`environment.json: settings for ${pluginId} must be an object`);
    // default: settings is an optional field of plugin.json; a plugin without it has no settings.
    const declarations = manifest.settings ?? {};
    for (const [key, value] of Object.entries(values)) {
      const declaration = declarations[key];
      if (!declaration) throw new Error(`environment.json: settings names unknown key ${pluginId}.${key}`);
      checkSettingValue(`environment.json: settings ${pluginId}.${key}`, declaration, value);
    }
  }
  for (const card of environment.workspace.grid.cards) {
    // default: tabs is an optional field of an environment.json card; a card without it is an empty slot.
    for (const tab of card.tabs ?? []) {
      // The tab of a plugin that is not loaded opens as a placeholder card (docs/spec/plugins.md).
      if (byId.has(tab.plugin) && !cards.has(tab.plugin)) throw new Error(`environment.json: tab plugin ${tab.plugin} has no surface`);
    }
  }
  normalizeSidebarDefaults(environment, manifests);
}

/** Values that cannot be used as a set id. */
const RESERVED_SET_IDS = ["off", "inherit"];

/** The maximum length of a set title. */
const SET_TITLE_MAX = 40;

function validatePluginSidebarDefaults(manifest) {
  const where = `plugin ${manifest.id}`;
  const sidebars = manifest.sidebars;
  if (!isObject(sidebars)) throw new Error(`${where}: sidebars must be an object`);
  only(`${where} sidebars`, sidebars, ["sets", "card", "window"]);
  validateSidebars({ sets: sidebars.sets, links: [] }, where);
  for (const set of sidebars.sets) {
    if (!ID.test(set.id)) throw new Error(`${where}: invalid local set id ${set.id}`);
  }
  const ids = new Set(sidebars.sets.map((set) => set.id));
  for (const [kind, sides] of [["card", ["top", "bottom", "left", "right"]], ["window", ["left", "right"]]]) {
    const mapping = sidebars[kind];
    if (mapping === undefined) continue;
    if (kind === "card" && !manifest.surface) throw new Error(`${where}: card defaults require a surface`);
    if (!isObject(mapping)) throw new Error(`${where}: sidebar ${kind} defaults must be an object`);
    only(`${where} sidebar ${kind}`, mapping, sides);
    for (const [side, set] of Object.entries(mapping)) {
      if (!ids.has(set)) throw new Error(`${where}: ${kind} ${side} names unknown set ${String(set)}`);
    }
  }
}

/** Normalizes the plugin defaults and replaces them with the explicit environment list. */
export function normalizeSidebarDefaults(environment, manifests) {
  const defaults = { sets: [], links: [] };
  for (const manifest of manifests) {
    if (manifest.sidebars === undefined) continue;
    validatePluginSidebarDefaults(manifest);
    for (const set of manifest.sidebars.sets) {
      defaults.sets.push({ ...set, id: `${manifest.id}.${set.id}`, sections: [...set.sections] });
    }
    for (const kind of ["card", "window"]) {
      // default: a layout kind omitted from the declaration has no default link.
      for (const [side, set] of Object.entries(manifest.sidebars[kind] ?? {})) {
        defaults.links.push({ place: `${kind}-${side}`, plugin: manifest.id, set: `${manifest.id}.${set}` });
      }
    }
  }
  validateSidebars(defaults, "plugin defaults");
  checkSidebarReferences(defaults, manifests, "plugin defaults");
  const result = environment.sidebars === undefined ? defaults : structuredClone(environment.sidebars);
  validateSidebars(result, "environment.json");
  checkSidebarReferences(result, manifests, "environment.json");
  return result;
}

/**
 * Validates the format of the sidebar sets (sets) and links (links). The sidebars of environment.json and the sets and links
 * stored in the settings follow the same rules. Throws an exception that starts with where when they are wrong. When loaded is the set of loaded plugin ids,
 * a link of a plugin that is not loaded is kept without requiring a known set, so that it is used again when that plugin is installed again.
 */
export function validateSidebars(sidebars, where, loaded = null) {
  if (!isObject(sidebars) || !Array.isArray(sidebars.sets) || !Array.isArray(sidebars.links)) {
    throw new Error(`${where}: sidebars requires sets and links`);
  }
  only(`${where} sidebars`, sidebars, ["sets", "links"]);
  const setIds = new Set();
  for (const set of sidebars.sets) {
    if (!isObject(set) || !isText(set.id) || typeof set.title !== "string" || !Array.isArray(set.sections)) {
      throw new Error(`${where}: every set requires id, title, and sections`);
    }
    only(`${where} set ${set.id}`, set, ["id", "title", "sections", "layout"]);
    if (set.title.length < 1 || set.title.length > SET_TITLE_MAX) {
      throw new Error(`${where}: set ${set.id} title must be 1 to ${SET_TITLE_MAX} characters`);
    }
    if (set.sections.some((id) => !isText(id))) throw new Error(`${where}: set ${set.id} sections must be section ids`);
    const listed = new Set();
    for (const id of set.sections) {
      if (listed.has(id)) throw new Error(`${where}: set ${set.id} lists section ${id} twice`);
      listed.add(id);
    }
    // A set shows all its sections stacked (list) or one at a time as tabs (tabs).
    if (!["list", "tabs"].includes(set.layout)) throw new Error(`${where}: set ${set.id} layout must be list or tabs`);
    // off of the setting choice and inherit of the per-card choice cannot be used as a set id.
    if (RESERVED_SET_IDS.includes(set.id)) throw new Error(`${where}: set id ${set.id} is reserved`);
    if (setIds.has(set.id)) throw new Error(`${where}: duplicate set ${set.id}`);
    setIds.add(set.id);
  }
  // The meaning of a link is the sidebar choice of docs/spec/settings.md. A left or right link whose plugin is null is a general choice;
  // the window (window-*) and card (card-*) links of a plugin are independent of each other and require a known set.
  const seen = new Set();
  for (const link of sidebars.links) {
    if (!isObject(link) || !["left", "right", "window-left", "window-right", "card-left", "card-right", "card-top", "card-bottom"].includes(link.place)) {
      throw new Error(`${where}: every link requires a place (left, right, window-left, window-right, card-left, card-right, card-top, card-bottom) and a known set`);
    }
    only(`${where} link`, link, ["place", "plugin", "set"]);
    if (link.plugin !== null && !isText(link.plugin)) throw new Error(`${where}: a link plugin is null or a plugin id`);
    const general = link.place === "left" || link.place === "right";
    if (general && link.plugin !== null) throw new Error(`${where}: a general window link requires plugin null`);
    if (!general && link.plugin === null) throw new Error(`${where}: a ${link.place} link names a plugin`);
    const kept = loaded !== null && link.plugin !== null && !loaded.has(link.plugin);
    if (!kept && !setIds.has(link.set)) throw new Error(`${where}: a ${link.place} link requires a known set`);
    // default: a link without plugin is a general sidebar link and is written as general in the overlap check key.
    const key = `${link.place} ${link.plugin ?? "general"}`;
    if (seen.has(key)) throw new Error(`${where}: link ${key} appears twice`);
    seen.add(key);
  }
  return sidebars;
}

/** The plugin id of a section id. A section id is `<plugin id>.<name>`. */
export const sectionPlugin = (id) => id.slice(0, id.indexOf("."));

/**
 * Validates the section ids of the sets and the plugin ids of the links with the loaded manifests. A section that a loaded plugin does not declare, and
 * a card side link of a loaded plugin that has no surface, throw an exception. A link that points to a plugin that is not loaded is kept
 * (docs/spec/plugins.md).
 */
export function checkSidebarReferences(sidebars, manifests, where) {
  const cards = new Set(manifests.filter((m) => m.surface).map((m) => m.id));
  const plugins = new Set(manifests.map((m) => m.id));
  // default: sections is an optional field of plugin.json; a plugin without it has no sections.
  const sections = new Set(manifests.flatMap((m) => (m.sections ?? []).map((s) => s.id)));
  for (const set of sidebars.sets) {
    for (const id of set.sections) {
      if (plugins.has(sectionPlugin(id)) && !sections.has(id)) throw new Error(`${where}: set ${set.id} names unknown section ${id}`);
    }
  }
  for (const link of sidebars.links) {
    if (link.plugin === null || !plugins.has(link.plugin)) continue;
    if (!link.place.startsWith("window-") && !cards.has(link.plugin)) {
      throw new Error(`${where}: link names plugin ${link.plugin} without a surface`);
    }
  }
}

/* ── Exposure ─────────────────────────────────────────────────────────
   The declaration format of the status, command and dom entries that the core and plugins expose to
   external clients, and the functions that apply a request to the entries registered in a
   document. The specification is docs/spec/exposure.md. */

/** The keys of the declaration file and the registration kinds. A declaration is written as commands; registration and listing are written as command. */
export const EXPOSE_KINDS = Object.freeze({ status: "status", commands: "command", dom: "dom" });

/** The codes of request failures. */
export const EXPOSURE_ERRORS = Object.freeze({
  failed: -32000,
  unknownMethod: -32601,
  invalidParams: -32602,
  unknownName: 1001,
  unregistered: 1002,
  gone: 1003,
  unavailable: 1004,
  timeout: 1005,
  inactive: 1006,
  noControl: 1009,
});

const OWNER = /^(core|host|[a-z][a-z0-9-]*)$/;
const NAME = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SCHEMA_TYPES = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  object: isObject,
  array: Array.isArray,
  null: (v) => v === null,
};

/** Validates one schema. The allowed keywords are type, properties, items and enum. */
function checkSchema(where, schema) {
  if (!isObject(schema)) throw new Error(`${where}: schema must be an object`);
  only(where, schema, ["type", "properties", "items", "enum"]);
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (types.length === 0 || types.some((type) => !Object.hasOwn(SCHEMA_TYPES, type))) {
      throw new Error(`${where}: unknown schema type ${JSON.stringify(schema.type)}`);
    }
  }
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) throw new Error(`${where}: properties must be an object`);
    for (const [key, value] of Object.entries(schema.properties)) checkSchema(`${where}.${key}`, value);
  }
  if (schema.items !== undefined) checkSchema(`${where}[]`, schema.items);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new Error(`${where}: enum must be a non-empty array`);
  }
}

/**
 * Returns whether the value satisfies the schema. properties checks only the keys that the value has.
 */
export function matchesSchema(schema, value) {
  if (schema.enum !== undefined && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) return false;
  if (schema.type !== undefined && ![].concat(schema.type).some((type) => SCHEMA_TYPES[type](value))) return false;
  if (schema.properties !== undefined && isObject(value)) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key) && !matchesSchema(sub, value[key])) return false;
    }
  }
  if (schema.items !== undefined && Array.isArray(value)) return value.every((item) => matchesSchema(schema.items, item));
  return true;
}

/**
 * Validates one `exposes` declaration. Throws when the format is wrong and returns the received value otherwise.
 *
 *     owner   first part of the name: core, host or a plugin id
 *   status  {name, description, schema}
 *     commands {name, description, params, result, timeout?}. params is a schema of type object.
 *                     timeout is the time (ms, 1–600000) that the host waits for the answer of the surface
 *   dom     {name, description, many?}
 *
 * A name is `<owner>.<name>` and consists of lowercase letters, digits, dots and hyphens. A name is declared
 * only once within one kind. The same name can be used in different kinds.
 */
/** The upper bound of the timeout of a command declaration (ms). */
export const COMMAND_TIMEOUT_MAX = 600000;

export function validateExposes(owner, exposes) {
  if (typeof owner !== "string" || !OWNER.test(owner)) throw new Error(`exposes: invalid owner ${owner}`);
  const where = `${owner} exposes`;
  if (!isObject(exposes)) throw new Error(`${where}: expected an object`);
  only(where, exposes, Object.keys(EXPOSE_KINDS));
  const seen = new Set();
  const fields = { status: ["schema"], commands: ["params", "result"], dom: [] };
  for (const [key, entries] of Object.entries(exposes)) {
    if (!Array.isArray(entries)) throw new Error(`${where}: ${key} must be an array`);
    for (const entry of entries) {
      if (!isObject(entry)) throw new Error(`${where}: ${key} entry must be an object`);
      const { name } = entry;
      if (typeof name !== "string" || !name.startsWith(`${owner}.`) || !NAME.test(name)) {
        throw new Error(`${where}: name ${name} must be ${owner}.<name> with lowercase letters, digits, dots, and hyphens`);
      }
      if (seen.has(`${key} ${name}`)) throw new Error(`${where}: duplicate ${key} ${name}`);
      seen.add(`${key} ${name}`);
      const at = `${where} ${name}`;
      only(at, entry, ["name", "description", ...fields[key], ...(key === "dom" ? ["many"] : []),
        ...(key === "commands" ? ["timeout"] : [])]);
      if (!isText(entry.description)) throw new Error(`${at}: description is required`);
      for (const field of fields[key]) {
        if (entry[field] === undefined) throw new Error(`${at}: ${field} is required`);
        checkSchema(`${at} ${field}`, entry[field]);
      }
      if (key === "commands" && entry.params.type !== "object") throw new Error(`${at}: params must be an object schema`);
      if (entry.many !== undefined && typeof entry.many !== "boolean") throw new Error(`${at}: many must be a boolean`);
      if (entry.timeout !== undefined
        && !(Number.isInteger(entry.timeout) && entry.timeout >= 1 && entry.timeout <= COMMAND_TIMEOUT_MAX)) {
        throw new Error(`${at}: timeout must be an integer from 1 to ${COMMAND_TIMEOUT_MAX} milliseconds`);
      }
    }
  }
  return exposes;
}

/**
 * Validates the diagnostics.json of a plugin together with the manifest. It is `{module, exposes}`; module is the
 * JavaScript path inside the plugin and exposes has the same format as exposes of plugin.json. Only a plugin that has a surface
 * can have it, and a name is declared in only one of plugin.json and diagnostics.json.
 */
export function validateDiagnostics(manifest, diagnostics) {
  const where = `plugin ${manifest.id} ${DIAGNOSTICS}`;
  if (manifest.surface === undefined) throw new Error(`${where}: diagnostics require a surface`);
  if (!isObject(diagnostics)) throw new Error(`${where}: expected an object`);
  only(where, diagnostics, ["module", "exposes"]);
  const { module } = diagnostics;
  if (!isText(module) || module.startsWith("/") || module.split("/").includes("..") || !module.endsWith(".js")) {
    throw new Error(`${where}: module must be a JavaScript path inside the package`);
  }
  validateExposes(manifest.id, diagnostics.exposes);
  // default: exposes is an optional field of plugin.json; a plugin without it exposes only the diagnostics entries.
  mergeExposes(manifest.exposes ?? {}, diagnostics.exposes);
  return diagnostics;
}

/** Merges two exposes declarations. Throws when the same name of the same kind is in both. */
export function mergeExposes(first, second) {
  declarationMap(second, declarationMap(first));
  return Object.fromEntries(Object.keys(EXPOSE_KINDS)
    .filter((key) => first[key] !== undefined || second[key] !== undefined)
    // default: each list of an exposure bundle is an optional field; a missing list is empty.
    .map((key) => [key, [...(first[key] ?? []), ...(second[key] ?? [])]]));
}

/**
 * Validates /installed-plugins.json that the host provides and returns the plugin list. An entry is { id, package, version,
 * diagnostics? }; diagnostics comes only from a diagnostic build. When the host cannot read the installation state, the document is { error }
 * and the function throws with that text.
 */
export function validateInstalledPlugins(document) {
  if (!isObject(document)) throw new Error(`${INSTALLED_PLUGINS}: expected an object`);
  if (document.error !== undefined) {
    if (!isText(document.error)) throw new Error(`${INSTALLED_PLUGINS}: error must be text`);
    throw new Error(`installed plugins: ${document.error}`);
  }
  only(INSTALLED_PLUGINS, document, ["plugins"]);
  if (!Array.isArray(document.plugins)) throw new Error(`${INSTALLED_PLUGINS}: plugins must be an array`);
  const ids = new Set();
  const packages = new Set();
  for (const plugin of document.plugins) {
    if (!isObject(plugin)) throw new Error(`${INSTALLED_PLUGINS}: every plugin must be an object`);
    only(`${INSTALLED_PLUGINS} plugin ${plugin.id}`, plugin, ["id", "package", "version", "manifest", "sidecars", "diagnostics"]);
    if (!isText(plugin.id) || !ID.test(plugin.id)) throw new Error(`${INSTALLED_PLUGINS}: plugin id ${plugin.id} is invalid`);
    if (!isText(plugin.package) || !PACKAGE.test(plugin.package)) {
      throw new Error(`${INSTALLED_PLUGINS}: plugin ${plugin.id} package must be a package.json name`);
    }
    if (!isText(plugin.version)) throw new Error(`${INSTALLED_PLUGINS}: plugin ${plugin.id} version is required`);
    if (plugin.manifest === undefined) throw new Error(`${INSTALLED_PLUGINS}: plugin ${plugin.id} manifest is required`);
    if (!isObject(plugin.manifest) || plugin.manifest.id !== plugin.id) {
      throw new Error(`${INSTALLED_PLUGINS}: plugin ${plugin.id} has a plugin.json with id ${plugin.manifest?.id}`);
    }
    try {
      validateManifest(plugin.manifest);
    } catch (error) {
      // States which installed plugin the rejected manifest belongs to. That file is plugins/<id>/<version>/plugin.json.
      throw new Error(`installed plugin ${plugin.id} ${plugin.version} (${plugin.package}): ${error.message}`);
    }
    // default: sidecars is an optional field of the installed plugin; without it the plugin has no sidecar facts.
    if (plugin.sidecars !== undefined) {
      // default: dependencies is an optional field of plugin.json; without it the plugin has no sidecar whose facts are checked.
      checkSidecarFacts(`${INSTALLED_PLUGINS}: plugin ${plugin.id}`, plugin.sidecars, plugin.manifest.dependencies ?? {});
    }
    if (plugin.diagnostics !== undefined && !isObject(plugin.diagnostics)) {
      throw new Error(`${INSTALLED_PLUGINS}: plugin ${plugin.id} diagnostics must be an object`);
    }
    if (ids.has(plugin.id)) throw new Error(`${INSTALLED_PLUGINS}: plugin ${plugin.id} appears twice`);
    if (packages.has(plugin.package)) throw new Error(`${INSTALLED_PLUGINS}: package ${plugin.package} appears twice`);
    ids.add(plugin.id);
    packages.add(plugin.package);
  }
  return document.plugins;
}

/** Validates one core declaration file (exposure.json). The owner of a name is core. */
export function validateExposureFile(file) {
  if (!isObject(file)) throw new Error(`${EXPOSURE}: expected an object`);
  only(EXPOSURE, file, ["exposes"]);
  validateExposes("core", file.exposes);
  return file;
}

/** The entry kinds that the request methods handle. */
export const METHOD_KINDS = Object.freeze({
  "status.get": "status", "status.watch": "status", "status.unwatch": "status", "status.next": "status",
  "command.run": "command", "dom.rect": "dom", "dom.act": "dom",
});

/** The key of a declaration Map: the pair of kind and name. */
export const declarationKey = (kind, name) => `${kind} ${name}`;

/**
 * Converts declarations into a Map that finds {kind, declaration} by declarationKey(kind, name).
 * Throws when the key already exists.
 */
export function declarationMap(exposes, into = new Map()) {
  for (const [key, kind] of Object.entries(EXPOSE_KINDS)) {
    // default: each list of an exposure bundle is an optional field; a missing list is empty.
    for (const declaration of exposes[key] ?? []) {
      const at = declarationKey(kind, declaration.name);
      if (into.has(at)) throw new Error(`${kind} ${declaration.name} is declared twice`);
      into.set(at, { kind, declaration });
    }
  }
  return into;
}

/** Returns the package.json name of the module that holds a staged document path, or null for another path. */
export function pagePackage(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "modules") return null;
  const name = parts[1]?.startsWith("@") ? parts.slice(1, 3).join("/") : parts[1];
  return name && PACKAGE.test(name) ? name : null;
}

/**
 * Returns the plugin of a page location, or null for a page that is not a plugin page. A `sok://<host>` page belongs to the
 * plugin whose id is its host, and its manifest is on its own origin. A staged page of the main origin belongs to the package
 * named by its module path. A sok host that is not a plugin id, or `core`, throws.
 */
export function pagePlugin(location) {
  if (location.protocol === "sok:") {
    // core is the reserved host of the core root, so it names no plugin.
    if (!ID.test(location.host) || location.host === "core") {
      throw new Error(`${location.href}: host ${location.host} is not a plugin id`);
    }
    return { host: location.host, manifest: `/${MANIFEST}` };
  }
  const name = pagePackage(location.pathname);
  return name ? { package: name, manifest: `/${modulePath(name, MANIFEST)}` } : null;
}

/**
 * Returns the plugin id of a page location and its validated plugin.json, or null for a page that is not a plugin page.
 * `read(path)` returns the parsed JSON of a path on the origin of the page. A sok page takes the id of its host, which its
 * plugin.json must carry. A staged page takes the id of the installed plugin whose package is its module name
 * (`installed-plugins.json`); a missing entry throws.
 */
export async function pageIdentity(location, read) {
  const page = pagePlugin(location);
  if (!page) return null;
  const manifest = validateManifest(await read(page.manifest));
  if (page.host !== undefined) {
    if (manifest.id !== page.host) throw new Error(`plugin.json id ${manifest.id} differs from the page plugin ${page.host}`);
    return { id: page.host, manifest };
  }
  const entry = validateInstalledPlugins(await read(`/${INSTALLED_PLUGINS}`)).find((plugin) => plugin.package === page.package);
  if (!entry) throw new Error(`${page.package}: no installed plugin has this package in ${INSTALLED_PLUGINS}`);
  if (manifest.id !== entry.id) throw new Error(`plugin.json id ${manifest.id} differs from the installed plugin ${entry.id}`);
  return { id: entry.id, manifest };
}

/** A request failure that has a code. The caller answers with {error: {code, message}}. */
export class ExposureError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The rectangle of an element, in CSS pixels relative to the viewport of the document that the element belongs to. */
export function elementRect(element) {
  const r = element.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

const KEYBOARD = /^key/;
const POINTER = /^pointer/;
const MOUSE = /^(mouse|click$|dblclick$|contextmenu$)/;

/**
 * Sends a synthetic DOM event to an element. The page receives an event whose isTrusted is false.
 *
 *   click     element.click()
 *     input     sets value and sends input and change
 *     dispatch  event = {type, ...init}. Creates a KeyboardEvent, PointerEvent,
 *                         MouseEvent or Event according to type. The default of bubbles is true
 */
export function actOn(element, { action, value, event }) {
  const view = element.ownerDocument.defaultView;
  if (action === "click") {
    element.click();
    return null;
  }
  if (action === "input") {
    if (typeof value !== "string") throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "input requires a string value");
    element.value = value;
    element.dispatchEvent(new view.Event("input", { bubbles: true }));
    element.dispatchEvent(new view.Event("change", { bubbles: true }));
    return null;
  }
  if (action === "dispatch") {
    if (!isObject(event) || !isText(event.type)) {
      throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "dispatch requires event.type");
    }
    const { type, ...init } = event;
    const Kind = KEYBOARD.test(type) ? view.KeyboardEvent
      : POINTER.test(type) ? view.PointerEvent
        : MOUSE.test(type) ? view.MouseEvent : view.Event;
    element.dispatchEvent(new Kind(type, { bubbles: true, cancelable: true, ...init }));
    return null;
  }
  throw new ExposureError(EXPOSURE_ERRORS.invalidParams, `unknown action ${action}`);
}

/**
 * The entries registered in one document. A name that the declarations (the result of declarationMap) do not contain cannot be registered.
 *
 * A status watch is delivered in two ways. changed(value) of watch is
 * called each time the value changes, and status.next answers with {version, value} when a value
 * newer than the version of the request exists. When the watch ends, a waiting status.next answers with {closed: true}.
 */
export function exposureEntries(declared) {
  const statuses = new Map();
  const commands = new Map();
  const doms = new Map();
  // The resolver of each dom entry that accepts an address (docs/spec/exposure.md, requests): resolve(address, elements) returns the element.
  const resolvers = new Map();
  const tables = { status: statuses, command: commands, dom: doms };

  const declaration = (kind, name) => {
    const found = declared.get(declarationKey(kind, name));
    if (!found) throw new Error(`${kind} ${name} is not declared`);
    return found.declaration;
  };

  // default: an unregistered dom name has no element, and the caller reports that case as an unregistered error.
  const elements = (name) => (doms.get(name) ?? []).flatMap((provide) => provide()).filter((el) => el.isConnected !== false);

  // A status value is JSON, and null is its no-value (docs/spec/declared-ui.md). undefined is not a JSON value, so it is refused.
  function jsonStatusValue(name, value) {
    if (value === undefined) throw new ExposureError(EXPOSURE_ERRORS.failed, `status ${name} value is undefined; a status value is JSON, and null is its no-value`);
    return value;
  }

  function status(name) {
    const entry = statuses.get(name);
    if (!entry) throw new ExposureError(EXPOSURE_ERRORS.unregistered, `status ${name} is not registered`);
    return entry;
  }

  function stop(entry) {
    entry.watching = false;
    const stopper = entry.stop;
    entry.stop = null;
    if (typeof stopper === "function") stopper();
    for (const resolve of entry.waiters.splice(0)) resolve({ closed: true });
  }

  function update(entry, value, changed) {
    if (!entry.watching) return;
    const text = JSON.stringify(jsonStatusValue(entry.name, value));
    if (text === entry.text) return;
    entry.text = text;
    entry.value = value;
    entry.version++;
    for (const resolve of entry.waiters.splice(0)) resolve({ version: entry.version, value: entry.value });
    changed(entry.value);
  }

  return {
    declared,

    /**
     * Follows one status registered in this document from inside the document. fn(value) is called with the current value and with each
     * later changed value. Throws when the name is not registered. Returns the function that stops following.
     */
    follow(name, fn) {
      const entry = status(name);
      let active = true;
      let text;
      const deliver = (value) => {
        const next = JSON.stringify(jsonStatusValue(name, value));
        if (!active || next === text) return;
        text = next;
        fn(value);
      };
      const stopper = entry.subscribe(deliver);
      Promise.resolve(entry.read()).then(deliver);
      return () => {
        active = false;
        if (typeof stopper === "function") stopper();
      };
    },

    /** Whether the name is registered in this document. A dom name is registered when an element is connected. */
    registered(kind, name) {
      return kind === "dom" ? elements(name).length > 0 : tables[kind].has(name);
    },

    status(name, read, subscribe) {
      declaration("status", name);
      if (statuses.has(name)) throw new Error(`status ${name} is already registered`);
      if (typeof read !== "function" || typeof subscribe !== "function") {
        throw new Error(`status ${name} requires read and subscribe functions`);
      }
      statuses.set(name, { name, read, subscribe, watching: false, stop: null, text: undefined, value: null, version: 0, waiters: [] });
    },

    command(name, run) {
      declaration("command", name);
      if (commands.has(name)) throw new Error(`command ${name} is already registered`);
      if (typeof run !== "function") throw new Error(`command ${name} requires a function`);
      commands.set(name, run);
    },

    /** provide is a function that returns an array of elements. Unless many is set, it registers only once. */
    dom(name, provide, resolve) {
      const { many } = declaration("dom", name);
      if (!many && doms.has(name)) throw new Error(`dom ${name} is already registered`);
      if (resolve !== undefined) {
        if (typeof resolve !== "function") throw new Error(`dom ${name} resolver must be a function`);
        if (resolvers.has(name)) throw new Error(`dom ${name} resolver is already registered`);
        resolvers.set(name, resolve);
      }
      // default: for the first registration of this name, there is no earlier provider.
      doms.set(name, [...(doms.get(name) ?? []), provide]);
    },

    /** Releases every registration of this document. It also ends the watches. */
    clear() {
      for (const entry of statuses.values()) stop(entry);
      statuses.clear();
      commands.clear();
      doms.clear();
    },

    /**
     * Handles one request and returns the result. Throws ExposureError when it fails.
     * changed(name, value) is called when the value of a watched status changes.
     */
    async answer(method, params, changed = () => {}) {
      const kind = METHOD_KINDS[method];
      if (!kind) throw new ExposureError(EXPOSURE_ERRORS.unknownMethod, `unknown method ${method}`);
      if (!isObject(params) || typeof params.name !== "string") {
        throw new ExposureError(EXPOSURE_ERRORS.invalidParams, `${method} requires name`);
      }
      const { name } = params;
      const found = declared.get(declarationKey(kind, name));
      if (!found) throw new ExposureError(EXPOSURE_ERRORS.unknownName, `unknown ${kind} ${name}`);
      if (method === "status.get") return jsonStatusValue(name, await status(name).read());
      if (method === "status.watch") {
        const entry = status(name);
        if (entry.watching) return null;
        entry.watching = true;
        const listen = (value) => update(entry, value, (v) => changed(name, v));
        entry.stop = entry.subscribe(listen);
        listen(await entry.read());
        return null;
      }
      if (method === "status.unwatch") {
        const entry = statuses.get(name);
        if (entry) stop(entry);
        return null;
      }
      if (method === "status.next") {
        const entry = status(name);
        if (!entry.watching) return { closed: true };
        if (!Number.isInteger(params.version)) {
          throw new ExposureError(EXPOSURE_ERRORS.invalidParams, `status.next for ${name} requires an integer version`);
        }
        if (entry.version > params.version) return { version: entry.version, value: entry.value };
        return new Promise((resolve) => entry.waiters.push(resolve));
      }
      if (method === "command.run") {
        const run = commands.get(name);
        if (!run) throw new ExposureError(EXPOSURE_ERRORS.unregistered, `command ${name} is not registered`);
        // command.run always carries params (docs/spec/exposure.md).
        if (!isObject(params.params)) {
          throw new ExposureError(EXPOSURE_ERRORS.invalidParams, `command.run for ${name} requires params`);
        }
        const input = params.params;
        if (!matchesSchema(found.declaration.params, input)) {
          throw new ExposureError(EXPOSURE_ERRORS.invalidParams, `invalid params for ${name}`);
        }
        // The cids of the cause of the request reach the handler as the member cids of its context, and none is dropped: an invalid
        // list is refused here, also for a handler that ignores them (docs/spec/exposure.md, requests).
        let cids;
        try {
          cids = causeCids(params.cids);
        } catch (error) {
          throw new ExposureError(EXPOSURE_ERRORS.invalidParams, `${method} for ${name}: ${error.message}`);
        }
        const result = await run(input, { cids });
        // A command that declares no result (result type null) answers null when it returns nothing. Any other command
        // returns a JSON value, so undefined is refused.
        if (result === undefined && found.declaration.result?.type === "null") return null;
        if (result === undefined) throw new ExposureError(EXPOSURE_ERRORS.failed, `command ${name} result is undefined; a result is a JSON value or null`);
        return result;
      }
      if (params.address !== undefined) {
        if (params.index !== undefined) throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "a request gives index or address, not both");
        const resolve = resolvers.get(name);
        if (!resolve) throw new ExposureError(EXPOSURE_ERRORS.invalidParams, `dom ${name} takes no address`);
        const element = resolve(params.address, elements(name));
        if (!element) throw new ExposureError(EXPOSURE_ERRORS.noControl, `dom ${name} has no element at the address`);
        if (method === "dom.rect") return elementRect(element);
        return actOn(element, params);
      }
      const list = elements(name);
      if (list.length === 0) throw new ExposureError(EXPOSURE_ERRORS.unregistered, `dom ${name} has no element`);
      if (!found.declaration.many && list.length > 1) {
        throw new ExposureError(EXPOSURE_ERRORS.unregistered, `dom ${name} has ${list.length} elements`);
      }
      // An absent index is the first element. A present index of another type, including null, is refused by the check below.
      const index = params.index === undefined ? 0 : params.index;
      if (!Number.isInteger(index) || index < 0) throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "index must be a non-negative integer");
      const element = list[index];
      if (!element) throw new ExposureError(EXPOSURE_ERRORS.unregistered, `dom ${name} has no element at index ${index}`);
      if (method === "dom.rect") return elementRect(element);
      return actOn(element, params);
    },
  };
}

/** Converts the result of a request into the answer format {result} or {error: {code, message}} of the relay. */
export async function replyPayload(work) {
  try {
    const result = await work();
    if (result === undefined) throw new ExposureError(EXPOSURE_ERRORS.failed, "a request returned undefined; a result is a JSON value or null");
    return { result };
  } catch (error) {
    // A general exception thrown by a registered function is a failure of execution, not of the request format.
    const code = error instanceof ExposureError ? error.code : EXPOSURE_ERRORS.failed;
    // default: the thrown value may not be an Error, so without message the value itself is written.
    return { error: { code, message: String(error?.message ?? error) } };
  }
}

/**
 * Exposure registration of a surface page.
 *
 * port is page.exposure of the runtime and load is a function that returns a declaration bundle in the manifest format or a declaration Map.
 * The declarations are read once at the first registration. Registration happens after the declarations are read,
 * and the returned promise is rejected when the name is not declared. A request that the main page forwards is
 * answered with the entries registered in this document.
 *
 * A watch is delivered through the path that the main page determines. The main page forwards status.watch and then
 * forwards status.next {name, version} repeatedly; this document answers with {version, value} when a value
 * newer than version exists.
 */
export function createExpose(port, load) {
  // A reply that the host refuses is reported through port.report, so a port without it would leave that failure nowhere.
  if (typeof port?.report !== "function") throw new TypeError("createExpose requires the port report function");
  let entries = null;
  let loaded = null;
  // The remover of the request listener that the port returns. Dispose calls it, so no request is answered after dispose.
  let stopRequests = null;
  // Set by dispose. A disposed exposure registers nothing, so a request listener is never added after dispose.
  let disposed = false;
  const ready = () => {
    // A registration or a binding after dispose is refused with an explicit error.
    if (disposed) return Promise.reject(new Error("exposure is disposed"));
    // default: concurrent requests share the same manifest loading Promise.
    entries ??= Promise.resolve().then(load).then(async (declarations) => {
      // A dispose that ran while the declarations were loading ends the exposure before its request listener is added.
      if (disposed) throw new Error("exposure is disposed");
      // The manifest file holds an array of bundles. The request path needs the canonical declaration map that
      // registry and exposureEntries use.
      const declared = declarations instanceof Map ? declarations : declarationMap(declarations);
      const made = exposureEntries(declared);
      loaded = made;
      stopRequests = await port.onRequest(({ id, method, params }) => {
        replyPayload(() => made.answer(method, params)).then(async (payload) => {
          try {
            await port.reply(id, payload);
          } catch (error) {
            // The host may have abandoned the request while the page was answering. The rejected reply is reported through
            // port.report; the host still owns the request and response decision.
            // default: a rejection that is not an Error carries its value as the diagnostic reason.
            const text = `exposure reply ${id}: ${String(error?.message ?? error)}`;
            try {
              await port.report(text);
            } catch (failure) {
              // A report that fails leaves no channel of the port, so the failure is given with both texts to reportError, which
              // dispatches the error event of the page that the page error path records.
              // default: a rejection that is not an Error carries its value as the failure text.
              globalThis.reportError(new Error(`${text}; report failed: ${String(failure?.message ?? failure)}`));
            }
          }
        });
      });
      return made;
    });
    return entries;
  };
  const registered = new Set();
  const register = async (kind, name, add) => {
    add(await ready());
    const key = declarationKey(kind, name);
    if (registered.has(key)) return;
    registered.add(key);
    await port.register(kind, name);
  };
  const bindings = new Set();
  const binder = createBinder((name, params) => ready().then((e) => e.answer("command.run", { name, params })), {
    check(name) {
      if (!loaded?.declared.has(declarationKey("command", name))) throw new Error(`command ${name} is not declared`);
    },
    changed: () => { for (const fn of bindings) fn(); },
  });
  /* The connection is made after the declarations are read. The returned promise is rejected when the command is not declared. */
  const binding = (fn) => async (...args) => {
    await ready();
    return fn(...args);
  };
  return {
    /** Connects an element to a command registered in this document. It is bind, mark and delegate of createBinder. */
    bind: binding(binder.bind),
    mark: binding(binder.mark),
    delegate: binding(binder.delegate),
    /** Runs a command declared in this document through the registry. */
    run: binding(binder.run),
    /** The operable elements in root that have neither a command nor a dom name. */
    audit: (root) => binder.audit(root),
    /** Calls fn when the connections change. Returns the release function. */
    onBinding(fn) {
      bindings.add(fn);
      return () => bindings.delete(fn);
    },
    status: (name, read, subscribe) => register("status", name, (e) => e.status(name, read, subscribe)),
    command: (name, run) => register("command", name, (e) => e.command(name, run)),
    dom: (name, element) => register("dom", name, (e) => {
      e.dom(name, () => [element]);
      element.dataset.expose = name;
    }),
    dispose: async () => {
      disposed = true;
      binder.dispose();
      // default: stopRequests is null when the page never became ready, so no request listener was added.
      stopRequests?.();
      stopRequests = null;
      loaded?.clear();
      registered.clear();
      // default: only a surface inside the main page unregisters. The port of a separate document has no unregister, and its registration ends with the document.
      await port.unregister?.();
    },
  };
}
