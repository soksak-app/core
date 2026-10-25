// Start of a core window-check run. It runs once, before the first check file, through --test-global-setup of node:test.
//
// The application executable to check is a build output of this repository. cargo decides that folder (it follows CARGO_TARGET_DIR), so
// it is found in target_directory of `cargo metadata` and declared as SOKSAK_BINARY_WAILSV3 and SOKSAK_BINARY_TAURIV2. A path that the run has already
// declared is kept. After the declaration, it runs the start of the harness (@soksak/window-check/session.mjs).
import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

/** Build output folder that cargo decides. If it is not found, the run fails with that reason. */
export function targetDirectory(run = (command, args) => spawnSync(command, args, { encoding: "utf8" })) {
  const result = run("cargo", ["metadata", "--format-version", "1", "--no-deps"]);
  if (result.error) throw new Error(`cargo metadata: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`cargo metadata exited with ${result.status}: ${String(result.stderr).trim()}`);
  const directory = JSON.parse(result.stdout).target_directory;
  if (typeof directory !== "string" || !directory) throw new Error("cargo metadata reported no target_directory");
  return directory;
}

/** Executable path inside the bundle of each app in the debug build of this repository. */
export function debugBinaries(target) {
  return Object.fromEntries(["wailsv3", "tauriv2"].map((name) => [
    `SOKSAK_BINARY_${name.toUpperCase()}`,
    join(target, "debug", `soksak-${name}.app`, "Contents", "MacOS", `soksak-${name}`),
  ]));
}

export async function globalSetup() {
  const declared = debugBinaries(targetDirectory());
  if (process.platform === "darwin" && !process.env.SOKSAK_CAPTURE_TEXT) {
    process.env.SOKSAK_CAPTURE_TEXT = captureTextCommand();
  }
  for (const [variable, path] of Object.entries(declared)) process.env[variable] ??= path;
  const { globalSetup: harness } = await import("@soksak/window-check/session.mjs");
  await harness();
}

/** Builds and resolves the declared native capture-text check executable. */
export function captureTextCommand(run = (command, args) => spawnSync(command, args, { encoding: "utf8", timeout: 30000 })) {
  const metadata = run("cargo", ["metadata", "--format-version", "1", "--no-deps"]);
  if (metadata.error) throw new Error(`cargo metadata: ${metadata.error.message}`);
  if (metadata.status !== 0) throw new Error(`cargo metadata exited with ${metadata.status}: ${String(metadata.stderr).trim()}`);
  const root = JSON.parse(metadata.stdout).workspace_root;
  if (typeof root !== "string" || !isAbsolute(root)) throw new Error("cargo metadata reported no absolute workspace_root");
  const result = run("make", ["--no-print-directory", "-s", "-C", join(root, "native", "darwin"), "capture-text-path"]);
  if (result.error) throw new Error(`capture text build: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`capture text build exited with ${result.status}: ${String(result.stderr).trim()}`);
  const command = result.stdout.trim();
  if (!isAbsolute(command) || command.includes("\n")) throw new Error("capture text build reported no single absolute executable path");
  return command;
}
