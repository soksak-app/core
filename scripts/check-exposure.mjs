// Checks that the names of exposed entries match their declarations.
//
// Rules (AGENTS.md, docs/spec/exposure.md):
//   1. Every exposed name written in the sources (names in quotes, data-expose, data-command, bindings and runs)
//      is declared.
//   2. Every declared status and command is registered, and every declared dom name is written as a value attached to an element.
// Whether an interactive element has a command and a dom name is judged by the audit of the running document (core.page.audit,
// unbound of core.surface.document). It is not guessed from the shape of the source.
// Checks the workbench (core). The check rules are in exposure-check.js of plugin-api, and each plugin repository checks the plugin pages with that module.
// --write rewrites core-exposure.json of plugin-api from the workbench declarations.
//
//   node scripts/check-exposure.mjs [--write]
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { auditExposure, sourceFiles } from "../packages/plugin-api/exposure-check.js";

const ROOT = new URL("../", import.meta.url).pathname;
const WORKBENCH = join(ROOT, "packages/workbench");
// A plugin repository reads the names of the core declarations from this file of plugin-api. It is created from the workbench declarations.
const CORE_EXPOSURE = join(ROOT, "packages/plugin-api/core-exposure.json");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** The status and command names of the workbench declarations. It is the content of core-exposure.json of plugin-api. */
export function coreExposureNames(exposes) {
  return {
    status: (exposes.status ?? []).map((e) => e.name),
    commands: (exposes.commands ?? []).map((e) => e.name),
  };
}

const coreExposes = readJson(join(WORKBENCH, "exposure.json")).exposes;
const names = `${JSON.stringify(coreExposureNames(coreExposes), null, 2)}\n`;
const errors = [];
if (process.argv.includes("--write")) writeFileSync(CORE_EXPOSURE, names);
if (readFileSync(CORE_EXPOSURE, "utf8") !== names) {
  errors.push("packages/plugin-api/core-exposure.json differs from packages/workbench/exposure.json; run node scripts/check-exposure.mjs --write");
}
const sources = [...sourceFiles(WORKBENCH, (name) => /\.(js|html)$/.test(name) && !name.endsWith(".mjs"))]
  .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }));
errors.push(...auditExposure({
  owner: "core",
  where: "packages/workbench",
  exposes: coreExposes,
  sources,
  // The core surface entries (core.surface.*) are registered by the plugin page interface.
  registrations: [readFileSync(join(ROOT, "packages/plugin-api/page.js"), "utf8")],
}));

// The declarations of a plugin are checked by each plugin repository with soksak-exposure of plugin-api (docs/spec/plugins.md#repositories).
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Exposure checks passed: core");
}
