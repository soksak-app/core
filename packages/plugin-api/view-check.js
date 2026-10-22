#!/usr/bin/env node
// Checks a plugin's literal copy of the view wire against the SDK (decision D1, required changes 5, 6, 7 and 12; F238-c-11).
// A plugin's make check runs it on its literal file, which holds three values: the SHA-256 of view-start.js, the four
// entries of VIEW_IMPORTS, and one screen-message vector. The script compares each value with the SDK and fails on the
// first difference it finds in each group. The check holds VIEW_START_SHA256 as a constant, so an edit of view-start.js
// fails here until the constant and every plugin literal are updated together.
//
//   soksak-view-check <literal.json> <screen-message vectors.json>
//
// The literal is JSON: {"viewStartSha256": "<64 hex>", "viewImports": {<four entries>}, "screenMessage": {"name", "message", "hash"}}.
// The vectors are the caller's input: the screen-message vectors of the core release that the plugin pins (the vector file of
// docs/spec/cases/log-contract/replay/screen-message.json in the core checkout). The package holds no path into a checkout.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { VIEW_IMPORTS } from "./index.js";

/** The SHA-256 of view-start.js as of this check. */
export const VIEW_START_SHA256 = "d96923ada1f03a2af97f8e09ee32bc323ec72f235fffc1d4519f6f641db1dffc";

const VIEW_START = new URL("./view-start.js", import.meta.url);

const shown = (value) => (value === undefined ? "undefined" : JSON.stringify(value));

/** The SHA-256 of a file as 64 lowercase hexadecimal characters. */
export function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The differences between a plugin literal and the SDK, one message each. `vectors` is the screen-message vector file that the
 * caller gives, and `scriptSha` is the SHA-256 of view-start.js, which defaults to the file of the package.
 */
export function checkViewLiteral(literal, {
  scriptSha = fileSha256(VIEW_START),
  vectors,
} = {}) {
  if (vectors === undefined) throw new Error("checkViewLiteral needs the screen-message vectors; the caller gives them");
  const errors = [];
  if (scriptSha !== VIEW_START_SHA256) {
    errors.push(`view-start.js is ${scriptSha}, the check holds ${VIEW_START_SHA256}; update the constant and every plugin literal`);
  }
  if (literal?.viewStartSha256 !== VIEW_START_SHA256) {
    errors.push(`viewStartSha256 is ${shown(literal?.viewStartSha256)}, want ${VIEW_START_SHA256}`);
  }
  // default: an absent import map is empty so every required import is reported missing.
  const imports = literal?.viewImports ?? {};
  for (const [key, want] of Object.entries(VIEW_IMPORTS)) {
    if (imports[key] !== want) errors.push(`viewImports ${shown(key)} is ${shown(imports[key])}, want ${shown(want)}`);
  }
  for (const key of Object.keys(imports)) {
    if (!Object.hasOwn(VIEW_IMPORTS, key)) errors.push(`viewImports has unexpected entry ${shown(key)}`);
  }
  const vector = literal?.screenMessage;
  const core = vectors.vectors.find((item) => item.name === vector?.name);
  if (!core) {
    errors.push(`screenMessage names no vector of the core fixture: ${shown(vector?.name)}`);
  } else {
    if (!isDeepStrictEqual(vector.message, core.message)) errors.push(`screenMessage ${shown(core.name)}: message differs from the core vector`);
    if (vector.hash !== core.hash) errors.push(`screenMessage ${shown(core.name)}: hash is ${shown(vector.hash)}, want ${shown(core.hash)}`);
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [literalPath, vectorsPath] = process.argv.slice(2);
  if (!literalPath || !vectorsPath) {
    console.error("usage: soksak-view-check <literal.json> <screen-message vectors.json>");
    process.exit(2);
  }
  const literal = JSON.parse(readFileSync(literalPath, "utf8"));
  const errors = checkViewLiteral(literal, { vectors: JSON.parse(readFileSync(vectorsPath, "utf8")) });
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("View literal checks passed");
  }
}
