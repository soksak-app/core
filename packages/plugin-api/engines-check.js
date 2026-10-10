#!/usr/bin/env node
// Checks that a plugin declares the core release that it uses for its build as engines.soksak (docs/spec/installation.md).
//
// Rule: engines.soksak in the package.json of a plugin repository is `*` (`>=0.0.0`, every core version), `^<version>` for the version of this @soksak/plugin-api,
// or `>=<x.y.z>` whose lower bound does not exceed that version.
//
//   soksak-engines [plugin repository]
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The version of this @soksak/plugin-api. It is the core release that a plugin uses for its build. */
export function pluginApiVersion() {
  return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
}

/** True when a and b are x.y.z and a is not greater than b. */
function notAbove(a, b) {
  const [x, y] = [a, b].map((text) => text.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return true;
}

/**
 * Returns one error unless engines.soksak in the plugin package.json is `*`, `^<version>`, or a `>=<x.y.z>` whose lower bound does not exceed this version,
 * `>=<x.y.z>` declares that the plugin installs on every core from that core on.
 */
export function enginesErrors(pkg, version) {
  const range = pkg?.engines?.soksak;
  const lower = typeof range === "string" ? /^>=(\d+\.\d+\.\d+)$/.exec(range) : null;
  return range === "*" || range === `^${version}` || (lower && notAbove(lower[1], version)) ? []
    : [`package.json: engines.soksak ${range} must be *, ^${version} or >= a version up to ${version}, the @soksak/plugin-api version`];
}

// A package manager places a package as a link, so the started path is resolved before it is compared with this module.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // default: when [plugin repository] of the usage is omitted, the plugin repository in the current folder is checked.
  const repository = resolve(process.argv[2] ?? ".");
  const version = pluginApiVersion();
  const pkg = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
  const errors = enginesErrors(pkg, version);
  if (errors.length) {
    process.stderr.write(errors.map((error) => `${error}\n`).join(""));
    process.exit(1);
  }
  process.stdout.write(`Engines check passed: engines.soksak is ${pkg.engines.soksak}\n`);
}
