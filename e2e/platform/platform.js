// Selects the platform operations of the window checks. Importing this file never depends on the operating system: each operation is
// an explicit contract of scripts/platform/platform.js, and an operation that the selected platform does not implement rejects with
// PlatformOperationNotImplemented (`<operation> is not implemented on <platform>`) when it is called.
import { join } from "node:path";
import { applicationArtifact, applicationExecutables, listProcesses, openApplication, PlatformOperationNotImplemented }
  from "../../scripts/platform/platform.js";

export { listProcesses, openApplication, PlatformOperationNotImplemented };

const APPLICATIONS = ["wailsv3", "tauriv2", "mygo"];

/**
 * The executables of the debug applications in the cargo target directory `target`, as the SOKSAK_BINARY_<APP> variables of the
 * harness, from the declared application artifact of the platform.
 */
export async function debugBinaries(target, { platform = process.platform } = {}) {
  const entries = [];
  for (const app of APPLICATIONS) {
    const artifact = await applicationArtifact(join(target, "debug"), app, { platform });
    entries.push([`SOKSAK_BINARY_${app.toUpperCase()}`, (await applicationExecutables(artifact, app, { platform })).application]);
  }
  return Object.fromEntries(entries);
}
