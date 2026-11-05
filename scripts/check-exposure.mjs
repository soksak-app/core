// Checks that the names of exposed entries match their declarations.
//
// Rules (AGENTS.md, docs/spec/exposure.md):
//   1. Every exposed name written in the sources (names in quotes, data-expose, data-command, bindings and runs)
//      is declared.
//   2. Every declared status and command is registered, and every declared element name is written as a value attached to an element.
// Whether an interactive element has a command and an element name is judged by the audit of the running workbench (core.workbench.audit,
// unbound of core.surface.document). It is not guessed from the shape of the source.
// Checks the workbench (core). The check rules are in exposure-check.js of plugin-api, and each plugin repository checks the plugin pages with that module.
// It also holds the copies of the workbench declarations equal to their source.
// --write rewrites core-exposure.json of plugin-api and the copies from the workbench declarations.
//
//   node scripts/check-exposure.mjs [--write]
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { auditExposure, sourceFiles } from "../packages/plugin-api/exposure-check.js";

const ROOT = new URL("../", import.meta.url).pathname;
const WORKBENCH = join(ROOT, "packages/workbench");
// A plugin repository reads the names of the core declarations from this file of plugin-api. It is created from the workbench declarations.
const CORE_EXPOSURE = join(ROOT, "packages/plugin-api/core-exposure.json");

// The copies of the declarations of another package, each held by the package that reads it.
export const DECLARATION_COPIES = Object.freeze([
  { source: "packages/workbench/workbench.json", copy: "packages/host/go/src/workbench.json" },
  { source: "packages/workbench/workbench.json", copy: "packages/host/rust/src/workbench.json" },
  { source: "packages/workbench/exposure.json", copy: "packages/workbench-mygo/src/exposure.json" },
  { source: "packages/workbench/shortcuts.json", copy: "packages/workbench-mygo/src/shortcuts.json" },
  { source: "packages/workbench/workbench.json", copy: "packages/workbench-mygo/src/workbench.json" },
  { source: "packages/plugin-api/contract/contributions.json", copy: "packages/workbench-mygo/tests/testdata/contributions.json" },
  { source: "apps/mygo/environment.json", copy: "packages/workbench-mygo/tests/testdata/application-environment.json" },
]);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** The status and command names of the workbench declarations. It is the content of core-exposure.json of plugin-api. */
export function coreExposureNames(exposes) {
  return {
    status: (exposes.status ?? []).map((e) => e.name),
    commands: (exposes.commands ?? []).map((e) => e.name),
  };
}

/** Names each copy whose bytes differ from its source. */
export function auditDeclarationCopies(copies, read) {
  return copies
    .filter(({ source, copy }) => read(copy) !== read(source))
    .map(({ source, copy }) => `${copy} differs from ${source}; run node scripts/check-exposure.mjs --write`);
}

// The registrations and the bindings of the Go sources of the mygo workbench, with the kind of each quoted name.
const WORKBENCH_NAME_USES = [
  { pattern: /\.Status\(\s*"([^"]+)"/g, kinds: [["status", "status"]] },
  { pattern: /\.Command\(\s*"([^"]+)"/g, kinds: [["commands", "command"]] },
  { pattern: /\.(?:Press|Control)\(\s*\w+,\s*"([^"]+)",\s*"([^"]+)"/g, kinds: [["element", "element name"], ["commands", "command"]] },
];

/** Names each status, command and element name that a Go source of the mygo workbench passes and that exposes does not declare. */
export function auditWorkbenchNames(exposes, sources) {
  const declared = (kind) => new Set(exposes[kind].map((entry) => entry.name));
  const errors = [];
  for (const { path, text } of sources) {
    text.split("\n").forEach((line, index) => {
      for (const { pattern, kinds } of WORKBENCH_NAME_USES) {
        for (const match of line.matchAll(pattern)) {
          kinds.forEach(([kind, label], position) => {
            const name = match[position + 1];
            if (!declared(kind).has(name)) errors.push(`${path}:${index + 1}: ${label} ${name} is not declared`);
          });
        }
      }
    });
  }
  return errors;
}

// The calls of a Go source of the mygo workbench that register a status or a command. A registration through another call reports its
// name as not registered, so a new function of registration is added here.
const WORKBENCH_REGISTRATIONS = {
  status: /\.Status\(\s*"([^"]+)"/g,
  commands: /(?:\.Command|\.CommandLater|\b(?:command|later|act|laterAct|laterCommand|windowAct|sectionCommand|change)(?:\[[^\]]*\])?)\(\s*(?:\w+,\s*)?"([^"]+)"/g,
};
// The entries that the view bridge registers in a surface document of the mygo workbench.
const BRIDGE_REGISTRATIONS = { status: /expose\.status\(\s*"([^"]+)"/g, commands: /expose\.command\(\s*"([^"]+)"/g };

/** Names each status and command that exposes declares and that no Go source of the mygo workbench and no view bridge source registers. */
export function auditWorkbenchRegistrations(exposes, sources, bridges = []) {
  const errors = [];
  for (const [kind, label] of [["status", "status"], ["commands", "command"]]) {
    const names = new Set();
    for (const { text } of sources) for (const match of text.matchAll(WORKBENCH_REGISTRATIONS[kind])) names.add(match[1]);
    for (const text of bridges) for (const match of text.matchAll(BRIDGE_REGISTRATIONS[kind])) names.add(match[1]);
    for (const { name } of exposes[kind]) {
      if (!names.has(name)) errors.push(`${label} ${name} is declared and no Go source of the mygo workbench registers it`);
    }
  }
  return errors;
}

if (process.argv[1]?.endsWith("check-exposure.mjs")) {
  const coreExposes = readJson(join(WORKBENCH, "exposure.json")).exposes;
  const names = `${JSON.stringify(coreExposureNames(coreExposes), null, 2)}\n`;
  const errors = [];
  if (process.argv.includes("--write")) {
    writeFileSync(CORE_EXPOSURE, names);
    for (const { source, copy } of DECLARATION_COPIES) writeFileSync(join(ROOT, copy), readFileSync(join(ROOT, source)));
  }
  if (readFileSync(CORE_EXPOSURE, "utf8") !== names) {
    errors.push("packages/plugin-api/core-exposure.json differs from packages/workbench/exposure.json; run node scripts/check-exposure.mjs --write");
  }
  errors.push(...auditDeclarationCopies(DECLARATION_COPIES, (path) => readFileSync(join(ROOT, path), "utf8")));
  const sources = [...sourceFiles(WORKBENCH, (name) => /\.(js|html)$/.test(name) && !name.endsWith(".mjs"))]
    .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }));
  errors.push(...auditExposure({
    owner: "core",
    where: "packages/workbench",
    exposes: coreExposes,
    sources,
    // The core document entries are registered by the view bridge in the actual surface document.
    registrations: [readFileSync(join(ROOT, "packages/plugin-api/view.js"), "utf8")],
  }));

  const goSources = [...sourceFiles(join(ROOT, "packages/workbench-mygo/src"), (name) => name.endsWith(".go"))]
    .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }));
  errors.push(...auditWorkbenchNames(coreExposes, goSources));
  errors.push(...auditWorkbenchRegistrations(coreExposes, goSources, [readFileSync(join(ROOT, "packages/plugin-api/view.js"), "utf8")]));

  // The declarations of a plugin are checked by each plugin repository with soksak-exposure of plugin-api (docs/spec/plugins.md#repositories).
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Exposure checks passed: core");
  }
}
