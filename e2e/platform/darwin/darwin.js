import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { cargoCommand } from "@soksak/window-check/cargo.mjs";

/** Executable paths inside the app bundles in the macOS debug build. */
export function debugBinaries(target) {
  return Object.fromEntries(["wailsv3", "tauriv2", "mygo"].map((name) => [
    `SOKSAK_BINARY_${name.toUpperCase()}`,
    join(target, "debug", `sok-${name}.app`, "Contents", "MacOS", `sok-${name}`),
  ]));
}

/** Builds and resolves the declared native capture-text check executable. `cargo` gives the cargo to run. */
export function captureTextCommand(run = (command, args) => spawnSync(command, args, { encoding: "utf8", timeout: 30000 }), cargo = cargoCommand) {
  const metadata = run(cargo(), ["metadata", "--format-version", "1", "--no-deps"]);
  if (metadata.error) throw new Error(`cargo metadata: ${metadata.error.message}`);
  if (metadata.status !== 0) throw new Error(`cargo metadata exited with ${metadata.status}: ${String(metadata.stderr).trim()}`);
  const root = JSON.parse(metadata.stdout).workspace_root;
  if (typeof root !== "string" || !isAbsolute(root)) throw new Error("cargo metadata reported no absolute workspace_root");
  const result = run("make", ["--no-print-directory", "-s", "-C", join(root, "native", "darwin"), "build-capture-text-path"]);
  if (result.error) throw new Error(`capture text build: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`capture text build exited with ${result.status}: ${String(result.stderr).trim()}`);
  const command = result.stdout.trim();
  if (!isAbsolute(command) || command.includes("\n")) throw new Error("capture text build reported no single absolute executable path");
  return command;
}

/** The limit of the warm-up of the capture recognizer: the first recognition of a language compiles its model, which takes minutes. */
export const CAPTURE_TEXT_WARM_LIMIT_MS = 600_000;

/**
 * Prepares the text recognition model of each language in a process of its own before a check recognizes, so the limit of a recognition
 * measures only the recognition. The first recognition of a language compiles the model of the system into the cache of the executable,
 * which takes minutes and can fail in the process that compiled it. Returns the report of the warm-up.
 */
export function warmCaptureText(command, languages, run = (name, args) => spawnSync(name, args, { encoding: "utf8", timeout: CAPTURE_TEXT_WARM_LIMIT_MS })) {
  if (!Array.isArray(languages) || languages.length === 0) throw new Error("the capture text warm-up needs at least one language");
  const result = run(command, ["--warm", ...languages]);
  if (result.error?.code === "ETIMEDOUT") throw new Error(`capture text warm-up of ${languages.join(", ")} exceeded ${CAPTURE_TEXT_WARM_LIMIT_MS} ms`);
  if (result.error) throw new Error(`capture text warm-up: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`capture text warm-up exited with ${result.status}: ${String(result.stderr).trim()}`);
  return String(result.stderr).trim();
}
