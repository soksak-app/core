// Checks that the names of exposed entries match their declarations.
//
// Rules (AGENTS.md, docs/spec/exposure.md):
//   1. Every exposed name written in the sources (names in quotes, data-expose, data-command, bindings and runs)
//      is declared.
//   2. Every declared status and command is registered, and every declared dom name is written as a value attached to an element.
// Whether an interactive element has a command and a dom name is judged by the audit of the running document (core.page.audit,
// unbound of core.surface.document). It is not guessed from the shape of the source.
// Checks the workbench (core) with the rules of scripts/exposure-rules.mjs.
//
//   node scripts/check-exposure.mjs
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { auditExposure, sourceFiles } from "./exposure-rules.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
const WORKBENCH = join(ROOT, "packages/workbench");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const coreExposes = readJson(join(WORKBENCH, "exposure.json")).exposes;
const errors = [];
const sources = [...sourceFiles(WORKBENCH, (name) => /\.(js|html)$/.test(name) && !name.endsWith(".mjs"))]
  .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, "utf8") }));
errors.push(...auditExposure({
  where: "packages/workbench",
  exposes: coreExposes,
  sources,
  // The core document entries are registered by the view bridge in the actual surface document.
  registrations: [readFileSync(join(ROOT, "packages/plugin-api/view.js"), "utf8")],
}));

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Exposure checks passed: core");
}
