// Start of a core window-check run. It runs once, before the first check file, through --test-global-setup of node:test.
//
// The application executable to check is a build output of this repository. cargo decides that folder (it follows CARGO_TARGET_DIR), so
// it is found in target_directory of `cargo metadata` and declared as SOKSAK_BINARY_WAILSV3 and SOKSAK_BINARY_TAURIV2. A path that the run has already
// declared is kept. After the declaration, it runs the start of the harness (@soksak/window-check/session.mjs).
import { spawnSync } from "node:child_process";
import { captureTextCommand, debugBinaries } from "./platform/platform.js";

export { captureTextCommand, debugBinaries };

/** Build output folder that cargo decides. If it is not found, the run fails with that reason. */
export function targetDirectory(run = (command, args) => spawnSync(command, args, { encoding: "utf8" })) {
  const result = run("cargo", ["metadata", "--format-version", "1", "--no-deps"]);
  if (result.error) throw new Error(`cargo metadata: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`cargo metadata exited with ${result.status}: ${String(result.stderr).trim()}`);
  const directory = JSON.parse(result.stdout).target_directory;
  if (typeof directory !== "string" || !directory) throw new Error("cargo metadata reported no target_directory");
  return directory;
}

export async function globalSetup() {
  const declared = debugBinaries(targetDirectory());
  if (!process.env.SOKSAK_CAPTURE_TEXT) {
    process.env.SOKSAK_CAPTURE_TEXT = captureTextCommand();
  }
  for (const [variable, path] of Object.entries(declared)) process.env[variable] ??= path;
  const { globalSetup: harness } = await import("@soksak/window-check/session.mjs");
  await harness();
}
