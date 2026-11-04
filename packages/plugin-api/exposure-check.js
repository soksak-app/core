#!/usr/bin/env node
// Checks in the sources that the names of exposed entries match the declarations (docs/spec/exposure.md).
//
// Rules:
//     1. Every exposed name written in a source (a name in quotes, data-expose, data-command, bindings and runs) is declared.
//     2. A declared status and command is registered, and a declared element name is written as a value attached to an element.
// The core checks the workbench with this check, and each plugin repository checks its own pages and sections. The core
// status and commands that a section module writes are compared with the declarations in core-exposure.json. Whether an operable element has a command and an element name is decided by the audit of the running
// document.
//
//   soksak-exposure [plugin repository]
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

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
 * and core is the name lists { status, commands } of the core, which a runtime.command call names. where is the place of the component
 * used in registration errors.
 */
export function auditExposure({ owner, where, exposes, sources, registrations = [], core = null, sections = [] }) {
  const errors = [];
  const report = (path, index, text) => errors.push(`${path}:${index + 1}: ${text}`);
  // default: status, commands and element of exposes are optional fields; when missing, there is no declaration of that kind.
  const entries = (list) => new Set((list ?? []).map((e) => e.name));
  const declared = { status: entries(exposes.status), command: entries(exposes.commands), element: entries(exposes.element) };
  // default: without core (the check of the core itself) the core name list is empty.
  const coreNames = (list) => new Set(list ?? []);
  const coreCommand = coreNames(core?.commands);
  // A name is declared when it is declared as one of the three kinds or is the id of a section of the plugin, which a section view
  // reads from its start values (docs/spec/plugins.md#sections).
  const sectionIds = new Set(sections);
  // default: a name that is no section id is looked up in the declared sets.
  const any = (name) => sectionIds.has(name) || Object.values(declared).some((set) => set.has(name));
  const quoted = new RegExp(`["'\`](${owner}\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)*)["'\`]`, "g");
  const shown = new Set();

  for (const { path, text } of sources) {
    text.split("\n").forEach((line, index) => {
      // 1. Names
      for (const [, name] of line.matchAll(quoted)) {
        if (!FILE.test(name) && !any(name)) report(path, index, `${name} is not declared`);
      }
      for (const [, name] of line.matchAll(/data-command=["']([^"']+)["']/g)) {
        if (!declared.command.has(name)) report(path, index, `data-command ${name} is not a declared command`);
      }
      for (const [, name] of line.matchAll(/\b(?:mark|bind)\(\s*\w+(?:\.\w+|\([^)]*\))*\s*,\s*["']([^"']+)["']/g)) {
        if (!declared.command.has(name)) report(path, index, `${name} is bound to an element but is not a declared command`);
      }
      // A view runs a command of core or a command of its plugin through runtime.command (docs/spec/native-surfaces.md#view-surfaces).
      for (const [, name] of line.matchAll(/\bruntime\.command\(\s*["']([^"']+)["']/g)) {
        if (!coreCommand.has(name) && !declared.command.has(name)) {
          report(path, index, `${name} is run through runtime.command but is not a command of core or a declared command of the plugin`);
        }
      }
      for (const [, name] of line.matchAll(/(?<!runtime\.)\b(?:run|command)\(\s*["']([^"']+)["']/g)) {
        if (!declared.command.has(name)) report(path, index, `${name} is run but is not a declared command`);
      }
      // A Set, because the attribute form data-expose="x" also matches the expose= form, and one name is one report.
      const elementNames = new Set([
        ...[...line.matchAll(/data-expose=["']([^"']+)["']/g)].map((m) => m[1]),
        ...[...line.matchAll(/[Ee]xpose\s*[:=]\s*["']([^"']+)["']/g)].map((m) => m[1]),
        ...(line.includes("dataset.expose") ? [...line.matchAll(quoted)].map((m) => m[1]) : []),
        ...[...line.matchAll(/(?:expose|context\.exposure)\.element\(\s*["']([^"']+)["']/g)].map((m) => m[1]),
      ]);
      // Some functions (act, field and others) take a name as an argument and attach it to an element, so a place where a declared element name is written in quotes
      // counts as a marked place.
      for (const [, name] of line.matchAll(quoted)) if (declared.element.has(name)) shown.add(name);
      for (const name of elementNames) {
        if (name.includes("${")) continue;
        shown.add(name);
        if (!declared.element.has(name)) report(path, index, `data-expose ${name} is not a declared element entry`);
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
    // A view registers its command through commands.register of the view bridge (docs/spec/native-surfaces.md#view-surfaces).
    const pattern = owner === "core" ? `(?:registry|expose)\\.command\\(\\s*"${name}"`
      : `(?:(?:expose|context\\.exposure)\\.command|commands\\.register)\\(\\s*["']${name}["']`;
    if (!new RegExp(pattern).test(all)) errors.push(`${where}: command ${name} is declared but not registered`);
  }
  for (const name of declared.element) {
    if (!shown.has(name)) errors.push(`${where}: element ${name} is declared but no element carries it`);
  }
  return errors;
}

/**
 * Checks one plugin repository. It merges plugin.json and diagnostics.json (the declarations of the diagnostic build) and compares them with the sources of ui/.
 * Paths are reported relative to the repository. It also checks the contract copies that the repository declares.
 */
export function checkPluginRepository(root, core = coreExposure()) {
  const manifest = readJson(join(root, "plugin.json"));
  const ui = join(root, "ui");
  const paths = existsSync(ui) ? [...sourceFiles(ui, (name) => /\.(js|html)$/.test(name))] : [];
  const diagnosticsPath = join(root, "diagnostics.json");
  // default: a plugin without diagnostics.json has no declarations of the diagnostic build.
  const diagnostics = existsSync(diagnosticsPath) ? readJson(diagnosticsPath).exposes : {};
  const exposes = Object.fromEntries(["status", "commands", "element"].map((key) =>
    // default: exposes and its entries are optional fields of plugin.json; when missing, there is no declaration.
    [key, [...(manifest.exposes?.[key] ?? []), ...(diagnostics[key] ?? [])]]));
  return auditExposure({
    owner: manifest.id, where: `plugin ${manifest.id}`, exposes,
    // default: sections is an optional field of plugin.json; without it the plugin has no section id.
    sections: (manifest.sections ?? []).map((section) => section.id),
    sources: paths.map((path) => ({ path: relative(root, path), text: readFileSync(path, "utf8") })),
    core,
  }).concat(checkContractCopies(root));
}

/**
 * The errors of the contract copies that contract-copies.json at root declares, { "<name>": "<sha256 hex>" }
 * (docs/spec/plugins.md#contract-copies): each name is a file of contract/ of this package, and its value is the SHA-256 of
 * that file.
 */
export function checkContractCopies(root) {
  const declarationPath = join(root, "contract-copies.json");
  // default: a plugin without contract-copies.json holds no contract copy.
  if (!existsSync(declarationPath)) return [];
  const contract = new URL("./contract/", import.meta.url);
  const names = new Set(readdirSync(contract));
  const errors = [];
  for (const [name, digest] of Object.entries(readJson(declarationPath))) {
    if (!names.has(name)) {
      errors.push(`contract copy ${name} has no published contract/${name}`);
    } else if (createHash("sha256").update(readFileSync(new URL(name, contract))).digest("hex") !== digest) {
      errors.push(`contract copy ${name} differs from contract/${name}`);
    }
  }
  return errors;
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
