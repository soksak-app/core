#!/usr/bin/env node
// Checks a plugin's literal copy of the view wire against the SDK (decision D1, required changes 5, 6, 7 and 12; F238-c-11).
// A plugin's make check runs it on its literal file, which holds three values: the SHA-256 of view-start.js, the four
// entries of VIEW_IMPORTS, and one screen-message vector. The script compares each value with the SDK and fails on the
// first difference it finds in each group. The check holds VIEW_START_SHA256 as a constant, so an edit of view-start.js
// fails here until the constant and every plugin literal are updated together.
//
//   soksak-view-check <literal.json> [screen-message vectors.json]
//
// The literal is JSON: {"viewStartSha256": "<64 hex>", "viewImports": {<four entries>}, "screenMessage": {"name", "message", "hash"}}.
// The vectors default to packages/log-contract/fixtures/replay/screen-message.json of the core checkout.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { VIEW_IMPORTS } from "./index.js";

/** The SHA-256 of view-start.js as of this check. */
export const VIEW_START_SHA256 = "aa1abb18bed83828bf9a14e7ade439ef5ae19528321feca8b846193e833775d5";

const VIEW_START = new URL("./view-start.js", import.meta.url);
const DEFAULT_VECTORS = new URL("../log-contract/fixtures/replay/screen-message.json", import.meta.url);

const shown = (value) => (value === undefined ? "undefined" : JSON.stringify(value));

/** The SHA-256 of a file as 64 lowercase hexadecimal characters. */
export function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The differences between a plugin literal and the SDK, one message each. `scriptSha` and `vectors` are injected by the
 * tests; the CLI reads them from the checkout.
 */
export function checkViewLiteral(literal, {
  scriptSha = fileSha256(VIEW_START),
  vectors = JSON.parse(readFileSync(DEFAULT_VECTORS, "utf8")),
} = {}) {
  const errors = [];
  if (scriptSha !== VIEW_START_SHA256) {
    errors.push(`view-start.js is ${scriptSha}, the check holds ${VIEW_START_SHA256}; update the constant and every plugin literal`);
  }
  if (literal?.viewStartSha256 !== VIEW_START_SHA256) {
    errors.push(`viewStartSha256 is ${shown(literal?.viewStartSha256)}, want ${VIEW_START_SHA256}`);
  }
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
  if (!literalPath) {
    console.error("usage: soksak-view-check <literal.json> [screen-message vectors.json]");
    process.exit(2);
  }
  const literal = JSON.parse(readFileSync(literalPath, "utf8"));
  const options = vectorsPath ? { vectors: JSON.parse(readFileSync(vectorsPath, "utf8")) } : {};
  const errors = checkViewLiteral(literal, options);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("View literal checks passed");
  }
}
