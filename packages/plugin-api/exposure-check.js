#!/usr/bin/env node
// Checks in the sources that the names of exposed entries match the declarations (docs/spec/exposure.md).
//
// Rules:
//     1. Every exposed name written in a source (a name in quotes, data-expose, data-command, bindings and runs) is declared.
//     2. A declared status and command is registered, and a declared dom name is written as a value attached to an element.
// The core checks the workbench with this check, and each plugin repository checks its own pages and sections. The core
// status and commands that a section module writes are compared with the declarations in core-exposure.json. Whether an operable element has a command and a dom name is decided by the audit of the running
// document.
//
//   soksak-exposure [plugin repository]
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/* A dotted name in quotes that is not an exposed name. It is a file name. */
const FILE = /\.(html|js|mjs|json|css)$/;

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** The names of the status and commands that the core declares. It is core-exposure.json, made from the workbench declarations of the core. */
export function coreExposure() {
  return readJson(new URL("./core-exposure.json", import.meta.url));
}

/** The files under dir that satisfy test. node_modules, test, dist and build are skipped. */
export function* sourceFiles(dir, test) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!["node_modules", "test", "dist", "build"].includes(name)) yield* sourceFiles(path, test);
    } else if (test(name)) {
      yield path;
    }
  }
}

/**
 * The error list of one component (the core or one plugin). sources is { path, text }, registrations is the statements of the registration code,
 * sections is the set of section module paths, and core is the name lists { status, commands } with which the core names
 * that a section module writes are checked. where is the place of the component used in registration errors.
 */
export function auditExposure({ owner, where, exposes, sources, registrations = [], sections = new Set(), core = null }) {
  const errors = [];
  const report = (path, index, text) => errors.push(`${path}:${index + 1}: ${text}`);
  // default: status, commands and dom of exposes are optional fields; when missing, there is no declaration of that kind.
  const entries = (list) => new Set((list ?? []).map((e) => e.name));
  const declared = { status: entries(exposes.status), command: entries(exposes.commands), dom: entries(exposes.dom) };
  // default: without core (the check of the core itself) there are no section modules, so the core name list is empty.
  const coreNames = (list) => new Set(list ?? []);
  const coreStatus = coreNames(core?.status);
  const coreCommand = coreNames(core?.commands);
  // A name is declared when it is declared as one of the three kinds.
  const any = (name) => Object.values(declared).some((set) => set.has(name));
  const quoted = new RegExp(`["'\`](${owner}\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)*)["'\`]`, "g");
  const shown = new Set();

  for (const { path, text } of sources) {
    text.split("\n").forEach((line, index) => {
      // 1. Names
      if (sections.has(path)) {
        for (const [, name] of line.matchAll(/["'`](core\.[a-z0-9-]+(?:\.[a-z0-9-]+)*)["'`]/g)) {
          if (!coreStatus.has(name) && !coreCommand.has(name)) report(path, index, `${name} is not a declared core status or command`);
        }
      }
      for (const [, name] of line.matchAll(quoted)) {
        if (!FILE.test(name) && !any(name)) report(path, index, `${name} is not declared`);
      }
      for (const [, name] of line.matchAll(/data-command=["']([^"']+)["']/g)) {
        if (!declared.command.has(name)) report(path, index, `data-command ${name} is not a declared command`);
      }
      for (const [, name] of line.matchAll(/\b(?:mark|bind)\(\s*\w+(?:\.\w+|\([^)]*\))*\s*,\s*["']([^"']+)["']/g)) {
        // A section module can also connect core commands (docs/spec/plugins.md#sections).
        const boundCore = sections.has(path) && coreCommand.has(name);
        if (!declared.command.has(name) && !boundCore) report(path, index, `${name} is bound to an element but is not a declared command`);
      }
      for (const [, name] of line.matchAll(/\b(?:run|command)\(\s*["']([^"']+)["']/g)) {
        if (!declared.command.has(name)) report(path, index, `${name} is run but is not a declared command`);
      }
      const domNames = [
        ...[...line.matchAll(/data-expose=["']([^"']+)["']/g)].map((m) => m[1]),
        ...[...line.matchAll(/[Ee]xpose\s*[:=]\s*["']([^"']+)["']/g)].map((m) => m[1]),
        ...(line.includes("dataset.expose") ? [...line.matchAll(quoted)].map((m) => m[1]) : []),
        ...[...line.matchAll(/(?:expose|context\.exposure)\.dom\(\s*["']([^"']+)["']/g)].map((m) => m[1]),
      ];
      // Some functions (act, field and others) take a name as an argument and attach it to an element, so a place where a declared dom name is written in quotes
      // counts as a marked place.
      for (const [, name] of line.matchAll(quoted)) if (declared.dom.has(name)) shown.add(name);
      for (const name of domNames) {
        if (name.includes("${")) continue;
        shown.add(name);
        if (!declared.dom.has(name)) report(path, index, `data-expose ${name} is not a declared dom entry`);
      }
    });
  }

  // 2. Registration and marking
  const all = sources.map((source) => source.text).join("\n") + registrations.join("\n");
  for (const name of declared.status) {
    const pattern = owner === "core" ? `status\\(\\s*"${name}"` : `(?:expose|context\\.exposure)\\.status\\(\\s*["']${name}["']`;
    if (!new RegExp(pattern).test(all)) errors.push(`${where}: status ${name} is declared but not registered`);
  }
  for (const name of declared.command) {
    const pattern = owner === "core" ? `(?:registry|expose)\\.command\\(\\s*"${name}"` : `(?:expose|context\\.exposure)\\.command\\(\\s*["']${name}["']`;
    if (!new RegExp(pattern).test(all)) errors.push(`${where}: command ${name} is declared but not registered`);
  }
  for (const name of declared.dom) {
    if (!shown.has(name)) errors.push(`${where}: dom ${name} is declared but no element carries it`);
  }
  return errors;
}

/**
 * Checks one plugin repository. It merges plugin.json and diagnostics.json (the declarations of the diagnostic build) and compares them with the sources of ui/.
 * Paths are reported relative to the repository.
 */
export function checkPluginRepository(root, core = coreExposure()) {
  const manifest = readJson(join(root, "plugin.json"));
  const ui = join(root, "ui");
  const paths = existsSync(ui) ? [...sourceFiles(ui, (name) => /\.(js|html)$/.test(name))] : [];
  const diagnosticsPath = join(root, "diagnostics.json");
  // default: a plugin without diagnostics.json has no declarations of the diagnostic build.
  const diagnostics = existsSync(diagnosticsPath) ? readJson(diagnosticsPath).exposes : {};
  const exposes = Object.fromEntries(["status", "commands", "dom"].map((key) =>
    // default: exposes and its entries are optional fields of plugin.json; when missing, there is no declaration.
    [key, [...(manifest.exposes?.[key] ?? []), ...(diagnostics[key] ?? [])]]));
  // default: sections is an optional field of plugin.json; when missing, there are no section modules.
  const sections = new Set((manifest.sections ?? []).flatMap((section) =>
    (typeof section.module === "string" ? [section.module] : [section.module.horizontal, section.module.vertical])));
  return auditExposure({
    owner: manifest.id, where: `plugin ${manifest.id}`, exposes,
    sources: paths.map((path) => ({ path: relative(root, path), text: readFileSync(path, "utf8") })),
    sections, core,
  });
}

// A package manager places a package as a link, so the started path is resolved before it is compared with this module.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // default: without an argument, the plugin repository in the current folder is checked.
  const root = resolve(process.argv[2] ?? ".");
  const errors = checkPluginRepository(root);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Exposure checks passed: plugin ${readJson(join(root, "plugin.json")).id}`);
  }
}
