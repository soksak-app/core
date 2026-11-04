#!/usr/bin/env node
// Places the frontend of the application in one directory (staging layout in docs/spec/plugins.md).
//
//   soksak-stage <output directory> [--diagnostics] [--no-main-page] [--installed <configuration directory>] [--registry-index <absolute index path>]
//
// Reads environment.json from the application package in the current directory. The package location is found
// by Node module resolution. The staged registry changes only when --registry-index is given.
//
// With --no-main-page the host draws the workbench itself and no page runs it: the output is the view root, the paths
// marked (view root) below, and environment.json names no runtime.
//
//   <output>/                        files of the workbench package
//   <output>/modules/<package.json name>/   the files of soksak and plugin-api (view root)
//   <output>/runtime/                 runtime directory of environment.json
//   <output>/environment.json         environment.json of the application (view root)
//   <output>/core-root.json           the core targets of the view import map, computed from the staged files by viewCoreTargets (view root)
//   <output>/view-imports.json        the JSON text of VIEW_IMPORTS, which each host passes to the native view handler (view root)
//   <output>/diagnostics.js           observe.js of the workbench (page diagnostic methods) with --diagnostics,
//   otherwise release-diagnostics.js (an empty module). Diagnostic code
//   goes only into diagnostic builds
//   <output>/transcript.js etc.       files that the diagnostic module uses with --diagnostics (STAGED.diagnostics of staged.js)
//
// Plugins are not put into the bundle. The native host provides the plugins installed in the configuration directory
// (docs/spec/installation.md). An application without a host (the browser example) gives the configuration directory with --installed,
// and then it writes the documents that the host would provide.
//
//   <output>/installed-plugins.json   list and manifests of the enabled installed plugins; diagnostics only with --diagnostics
//   <output>/modules/<plugin>/       files of each enabled installed plugin
//   <output>/shared/<id>.<point>/      the shared modules of extension points

import { parseArgs } from "node:util";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { STAGED, missingPageReferences } from "./staged.js";
import {
  CORE_ROOT_FILE, ENVIRONMENT, INSTALLED_PLUGINS, PAGE_IMPORTS, RUNTIME, VIEW_IMPORTS_FILE,
  modulePath, pageImports, pageImportsForBuild, validateEnvironment, validateInstalledPlugins, viewCoreTargets, viewImports,
} from "@soksak/plugin-api";

const USAGE = "usage: soksak-stage <output directory> [--diagnostics] [--no-main-page] [--installed <configuration directory>] [--registry-index <absolute index path>]";
let parsed;
try {
  parsed = parseArgs({
    options: {
      diagnostics: { type: "boolean", default: false }, "no-main-page": { type: "boolean", default: false },
      installed: { type: "string" }, "registry-index": { type: "string" },
    },
    allowPositionals: true, strict: true, tokens: true,
  });
  // parseArgs keeps the last value of a repeated option, so a repeated option is found from the tokens and refused.
  const names = parsed.tokens.filter((token) => token.kind === "option").map((token) => token.name);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) throw new Error(`--${repeated} is given more than once`);
} catch (error) {
  console.error(`${error.message}\n${USAGE}`);
  process.exit(2);
}
if (parsed.positionals.length !== 1) {
  console.error(USAGE);
  process.exit(2);
}
const [out] = parsed.positionals;
const { diagnostics, "no-main-page": noMainPage, installed: installedDirectory, "registry-index": registryIndex } = parsed.values;

const app = process.cwd();
const target = resolve(app, out);
const workbench = dirname(fileURLToPath(import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Finds the directory of the package name through the dependencies of the package from. */
function packageDir(from, name) {
  return dirname(createRequire(join(from, "package.json")).resolve(`${name}/package.json`));
}

/** Copies the files entries of a package to dest. Fails if files is absent. */
function copyPackage(dir, dest) {
  const { name, files } = readJson(join(dir, "package.json"));
  if (!Array.isArray(files)) throw new Error(`${name}: package.json requires files`);
  for (const file of files) cpSync(join(dir, file), join(dest, file), { recursive: true });
}

/**
 * Reads the enabled plugins in id order from plugins/installed.json of the configuration directory. The format is written and validated by the command line sok
 * (docs/spec/installation.md). Here it only checks that the fields in use exist, and fails if they do not.
 */
function enabledInstalledPlugins(configuration) {
  const file = join(configuration, "plugins", "installed.json");
  if (!existsSync(file)) throw new Error(`${file} does not exist; install plugins with sok first`);
  const installed = readJson(file);
  // The format that sok writes (INSTALLED_FORMAT of sok). No other format is read: an older file is refused by name, not converted.
  if (installed?.format !== 3) {
    throw new Error(`${file}: format ${installed?.format} is not 3, the format that sok writes`);
  }
  if (typeof installed.plugins !== "object" || installed.plugins === null) {
    throw new Error(`${file}: expected format 3 with plugins`);
  }
  return Object.entries(installed.plugins)
    .filter(([, plugin]) => plugin.enabled === true)
    .map(([id, plugin]) => {
      if ("package" in plugin) throw new Error(`${file}: plugins/installed.json ${id}: unknown field package`);
      if (typeof plugin.version !== "string" || typeof plugin.path !== "string") {
        throw new Error(`${file}: plugin ${id} requires version and path`);
      }
      // Files are read only from the folder that the installation recorded as a path relative to the configuration directory (docs/spec/installation.md).
      // The name is the name of the package.json in that folder.
      const dir = join(configuration, plugin.path);
      const { name } = readJson(join(dir, "package.json"));
      if (typeof name !== "string") throw new Error(`${join(dir, "package.json")}: expected a package.json name`);
      return { id, package: name, version: plugin.version, dir };
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

const environmentInput = readJson(join(app, ENVIRONMENT));
if (registryIndex !== undefined) {
  if (!isAbsolute(registryIndex)) throw new Error("--registry-index must be an absolute file path");
  environmentInput.registry = pathToFileURL(registryIndex).href;
}
const environment = validateEnvironment(environmentInput);
if (noMainPage && environment.runtime !== undefined) throw new Error("--no-main-page refuses the runtime of environment.json");
if (!noMainPage && environment.runtime === undefined) throw new Error("a main page requires runtime in environment.json");
if (!noMainPage && !existsSync(join(app, environment.runtime, "index.js"))) throw new Error(`${environment.runtime}/index.js is missing`);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

if (!noMainPage) {
  copyPackage(workbench, target);
  const pagePath = join(target, "index.html");
  const page = readFileSync(pagePath, "utf8");
  const declaredPageImports = pageImports(page);
  if (JSON.stringify(declaredPageImports) !== JSON.stringify(PAGE_IMPORTS)) {
    throw new Error(`${pagePath}: the workbench import map differs from PAGE_IMPORTS`);
  }
  const pageImportMap = JSON.stringify({ imports: pageImportsForBuild({ diagnostics }) }, null, 2);
  const stagedPage = page.replace(/<script type="importmap">[\s\S]*?<\/script>/,
    `<script type="importmap">\n${pageImportMap}\n</script>`);
  writeFileSync(pagePath, stagedPage);
}
for (const name of ["soksak", "@soksak/plugin-api"]) {
  copyPackage(packageDir(workbench, name), join(target, modulePath(name, "")));
}
for (const { package: name, file } of STAGED.viewDiagnostics) {
  const path = join(target, modulePath(name, file));
  if (diagnostics && !existsSync(path)) throw new Error(`declared diagnostic view module is missing: ${modulePath(name, file)}`);
  if (!diagnostics) rmSync(path, { force: true });
}
if (!noMainPage) {
  cpSync(join(app, environment.runtime), join(target, RUNTIME), { recursive: true });
  copyFileSync(join(workbench, diagnostics ? "observe.js" : "release-diagnostics.js"), join(target, "diagnostics.js"));
  if (diagnostics) {
    for (const file of STAGED.diagnostics) copyFileSync(join(workbench, file), join(target, file));
  }
}
writeFileSync(join(target, ENVIRONMENT), `${JSON.stringify(environment, null, 2)}\n`);
// The core targets are computed from the staged files, so the list names only files that the staged frontend holds.
const coreTargets = new Set(viewCoreTargets((name, file) => {
  const path = join(target, modulePath(name, file));
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}));
if (diagnostics) {
  for (const { package: name, file } of STAGED.viewDiagnostics) coreTargets.add(`/${modulePath(name, file)}`);
}
writeFileSync(join(target, CORE_ROOT_FILE), `${JSON.stringify([...coreTargets].sort())}\n`);
// The view import map is the JSON text of VIEW_IMPORTS, which each host passes to the native view handler as the text it inserts.
writeFileSync(join(target, VIEW_IMPORTS_FILE), JSON.stringify({ imports: viewImports({ diagnostics }) }));

let plugins = [];
if (installedDirectory) {
  plugins = enabledInstalledPlugins(resolve(app, installedDirectory));
  const document = [];
  for (const plugin of plugins) {
    cpSync(plugin.dir, join(target, modulePath(plugin.package, "")), { recursive: true });
    const entry = { id: plugin.id, package: plugin.package, version: plugin.version, manifest: readJson(join(plugin.dir, "plugin.json")) };
    // Places the shared modules of extension points where a host serves /shared/<plugin id>.<point>/<specifier>.js (docs/spec/installation.md).
    // default: extends is an optional field of plugin.json; a plugin without it shares no module.
    for (const [point, declaration] of Object.entries(entry.manifest.extends ?? {})) {
      // default: a point without modules shares no module.
      for (const [specifier, path] of Object.entries(declaration.modules ?? {})) {
        const shared = join(target, "shared", `${plugin.id}.${point}`, `${specifier}.js`);
        mkdirSync(dirname(shared), { recursive: true });
        copyFileSync(join(plugin.dir, path), shared);
      }
    }
    const declared = join(plugin.dir, "diagnostics.json");
    // default: a plugin without diagnostics.json has no diagnostic declaration.
    if (diagnostics && existsSync(declared)) entry.diagnostics = readJson(declared);
    document.push(entry);
  }
  validateInstalledPlugins({ plugins: document });
  writeFileSync(join(target, INSTALLED_PLUGINS), `${JSON.stringify({ plugins: document })}\n`);
}

// Verifies that the files of the STAGED list were actually created,
// so the declaration and the result do not diverge.
for (const stagedFile of noMainPage ? STAGED.view : STAGED.always) {
  if (!existsSync(join(target, stagedFile))) throw new Error(`declared always-staged file not created: ${stagedFile}`);
}
if (diagnostics && !noMainPage) {
  for (const stagedFile of STAGED.diagnostics) {
    if (!existsSync(join(target, stagedFile))) throw new Error(`declared diagnostics-staged file not created: ${stagedFile}`);
  }
}
// A page that reaches a file outside the staged frontend stops before the application is ready, so the staging fails instead of the window.
const missing = noMainPage ? [] : STAGED.pages.flatMap((page) => missingPageReferences(target, page));
if (missing.length > 0) throw new Error(`the staged pages reach files that are not staged:\n${missing.join("\n")}`);
console.log(`staged ${noMainPage ? "the view root" : "the workbench"} into ${target}${installedDirectory ? ` with ${plugins.length} installed plugins` : ""}` +
  (diagnostics ? " with diagnostics" : ""));
