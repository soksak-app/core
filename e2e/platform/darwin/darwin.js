import { join } from "node:path";

/** Executable paths inside the app bundles in the macOS debug build. */
export function debugBinaries(target) {
  return Object.fromEntries(["wailsv3", "tauriv2", "mygo"].map((name) => [
    `SOKSAK_BINARY_${name.toUpperCase()}`,
    join(target, "debug", `sok-${name}.app`, "Contents", "MacOS", `sok-${name}`),
  ]));
}
