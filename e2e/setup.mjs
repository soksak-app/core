// Declares application binaries for window checks from the Cargo build output.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cargoCommand } from "@soksak/window-check/cargo.mjs";
import { debugBinaries } from "./platform/platform.js";

export { debugBinaries };

/** Build output folder that cargo decides. If it is not found, the run fails with that reason. `cargo` gives the cargo to run. */
export function targetDirectory(run = (command, args) => spawnSync(command, args, { encoding: "utf8" }), cargo = cargoCommand) {
  const result = run(cargo(), ["metadata", "--format-version", "1", "--no-deps"]);
  if (result.error) throw new Error(`cargo metadata: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`cargo metadata exited with ${result.status}: ${String(result.stderr).trim()}`);
  const directory = JSON.parse(result.stdout).target_directory;
  if (typeof directory !== "string" || !directory) throw new Error("cargo metadata reported no target_directory");
  return directory;
}

/** The limit of the core window-check setup: the declaration of the binaries. */
export const E2E_SETUP_LIMIT_MS = 300_000;

export async function globalSetup() {
  const { withSetupLimit } = await import("@soksak/window-check/session.mjs");
  await withSetupLimit("e2e setup", E2E_SETUP_LIMIT_MS, async () => {
    const variables = ["WAILSV3", "TAURIV2", "MYGO"].map(name => `SOKSAK_BINARY_${name}`);
    if (variables.every(variable => process.env[variable])) return;
    const declared = debugBinaries(targetDirectory());
    for (const [variable, path] of Object.entries(declared)) process.env[variable] ??= path;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await globalSetup();
