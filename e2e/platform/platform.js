// Default artifact discovery is an operation of the selected platform, not an import requirement.
import { debugBinaries as darwinDebugBinaries } from "./darwin/darwin.js";

export function debugBinaries(target, { platform = process.platform } = {}) {
  if (platform === "darwin") return darwinDebugBinaries(target);
  throw new Error(`Default E2E executable discovery is not implemented on ${platform}; declare SOKSAK_BINARY_WAILSV3, SOKSAK_BINARY_TAURIV2 and SOKSAK_BINARY_MYGO`);
}
