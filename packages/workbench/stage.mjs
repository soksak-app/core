#!/usr/bin/env node
// Places the frontend of the application in one directory (staging layout in docs/spec/plugins.md).
//
//   soksak-stage <output directory> [--diagnostics] [--installed <configuration directory>]
//
// Reads environment.json from the application package in the current directory. The package location is found
// by Node module resolution. Files are only copied and their content is not changed.
//
//   <output>/                        files of the workbench package
//   <output>/modules/<package.json name>/   the files of soksak and plugin-api
//   <output>/runtime/                 runtime directory of environment.json
//   <output>/environment.json         environment.json of the application
//   <output>/core-root.json           the core targets of the view import map, computed from the staged files by viewCoreTargets
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STAGED } from "./staged.js";
import {
  CORE_ROOT_FILE, ENVIRONMENT, INSTALLED_PLUGINS, RUNTIME, modulePath, validateEnvironment, validateInstalledPlugins, viewCoreTargets,
} from "@soksak/plugin-api";

const USAGE = "usage: soksak-stage <output directory> [--diagnostics] [--installed <configuration directory>]";
let parsed;
try {
  parsed = parseArgs({
    options: { diagnostics: { type: "boolean", default: false }, installed: { type: "string" } },
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
const { diagnostics, installed: installedDirectory } = parsed.values;

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
  // A format 1 file is converted to format 2 when sok or the application reads it.
  if (installed?.format !== 2 || typeof installed.plugins !== "object" || installed.plugins === null) {
    throw new Error(`${file}: expected format 2 with plugins`);
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

const environment = validateEnvironment(readJson(join(app, ENVIRONMENT)));
const runtime = join(app, environment.runtime);
if (!existsSync(join(runtime, "index.js"))) throw new Error(`${environment.runtime}/index.js is missing`);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

copyPackage(workbench, target);
for (const name of ["soksak", "@soksak/plugin-api"]) {
  copyPackage(packageDir(workbench, name), join(target, modulePath(name, "")));
}
cpSync(runtime, join(target, RUNTIME), { recursive: true });
copyFileSync(join(workbench, diagnostics ? "observe.js" : "release-diagnostics.js"), join(target, "diagnostics.js"));
if (diagnostics) {
  for (const file of STAGED.diagnostics) copyFileSync(join(workbench, file), join(target, file));
}
writeFileSync(join(target, ENVIRONMENT), `${JSON.stringify(environment, null, 2)}\n`);
// The core targets are computed from the staged files, so the list names only files that the staged frontend holds.
const coreTargets = viewCoreTargets((name, file) => {
  const path = join(target, modulePath(name, file));
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
});
writeFileSync(join(target, CORE_ROOT_FILE), `${JSON.stringify(coreTargets)}\n`);

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
for (const stagedFile of STAGED.always) {
  if (!existsSync(join(target, stagedFile))) throw new Error(`declared always-staged file not created: ${stagedFile}`);
}
if (diagnostics) {
  for (const stagedFile of STAGED.diagnostics) {
    if (!existsSync(join(target, stagedFile))) throw new Error(`declared diagnostics-staged file not created: ${stagedFile}`);
  }
}
console.log(`staged the workbench into ${target}${installedDirectory ? ` with ${plugins.length} installed plugins` : ""}` +
  (diagnostics ? " with diagnostics" : ""));
