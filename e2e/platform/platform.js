// Selects the platform operations of the window checks. Importing this file never depends on the running operating system: each
// operation is an explicit contract, and an operation that the selected platform does not implement throws
// PlatformOperationNotImplemented (`<operation> is not implemented on <platform>`) when it is called.
import { join } from "node:path";
import { applicationBundle, artifactExecutables, PlatformOperationNotImplemented } from "../../scripts/platform/platform.js";
import * as darwin from "./darwin/darwin.js";

export { PlatformOperationNotImplemented };

const APPLICATIONS = ["wailsv3", "tauriv2", "mygo"];
const implementations = new Map([["darwin", darwin]]);

/**
 * The executables of the debug applications in the cargo target directory `target`, as the SOKSAK_BINARY_<APP> variables of the
 * harness, from the declared application artifact of the platform.
 */
export function debugBinaries(target, { platform = process.platform } = {}) {
  return Object.fromEntries(APPLICATIONS.map((app) => [
    `SOKSAK_BINARY_${app.toUpperCase()}`,
    artifactExecutables(applicationBundle(join(target, "debug"), app, { platform }), app, { platform }).application,
  ]));
}

/**
 * The keyboard input sources that the activation checks select through `diagnostics.input.source`: `latin` types Latin letters
 * without composition, `korean` composes Hangul with the 2-set layout and `japanese` composes kana from romaji. Each value is the
 * identifier of the input source on the platform.
 */
export function inputSources({ platform = process.platform } = {}) {
  const implementation = implementations.get(platform);
  if (implementation === undefined || typeof implementation.inputSources !== "function") {
    throw new PlatformOperationNotImplemented("keyboard input sources", platform);
  }
  return implementation.inputSources();
}
