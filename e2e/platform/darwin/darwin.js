import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

/** Executable paths inside the app bundles in the macOS debug build. */
export function debugBinaries(target) {
  return Object.fromEntries(["wailsv3", "tauriv2"].map((name) => [
    `SOKSAK_BINARY_${name.toUpperCase()}`,
    join(target, "debug", `soksak-${name}.app`, "Contents", "MacOS", `soksak-${name}`),
  ]));
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
