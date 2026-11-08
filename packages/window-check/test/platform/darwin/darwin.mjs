// The darwin facilities of the owner tests of the window checks (test/platform/platform.js).
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Builds the FSEvents fault injection `name` (`<name>.c` of this folder) into a library in `folder` and returns the environment
 * that makes dyld load it into a child process.
 */
export function watcherFaultEnvironment(name, folder) {
  const library = join(folder, `${name}.dylib`);
  execFileSync("cc", ["-dynamiclib", "-framework", "CoreServices", "-o", library, join(here, `${name}.c`)]);
  return { DYLD_INSERT_LIBRARIES: library };
}

/** macOS samples a live process with /usr/bin/sample, names its launchd services with launchctl and file holders with lsof. */
export function liveProcessSampling() {}
