// The common setup of the window checks declares the debug application bundles of macOS, so this test runs only on macOS (the
// application artifact and its executables are operations of macOS in scripts/platform/platform.js). The executables of the bundles
// are judged by debug-binaries.test.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cargoCommand } from "@soksak/window-check/cargo.mjs";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const SETUP = JSON.stringify(new URL("../../../../setup.mjs", import.meta.url).href);
/** The build output folder of the repository that the cargo of the toolchain reports. */
const reported = () => JSON.parse(spawnSync(cargoCommand(), ["metadata", "--format-version", "1", "--no-deps"], { cwd: ROOT, encoding: "utf8" }).stdout).target_directory;

test("common setup declares binaries without building anything", { timeout: 60000 }, () => {
  // The setup runs the cargo of the toolchain only for its metadata: the target folder gains no entry that a build writes.
  const target = reported();
  const before = existsSync(target) ? readdirSync(target).sort() : null;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { globalSetup } = await import(${SETUP});
    await globalSetup();
    process.stdout.write(JSON.stringify({ binary: process.env.SOKSAK_BINARY_MYGO }));
  `], { cwd: ROOT, encoding: "utf8", timeout: 60000, env: Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith("SOKSAK_BINARY_") && key !== "CARGO")) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { binary: join(target, "debug/sok-mygo.app/Contents/MacOS/sok-mygo") });
  assert.deepEqual(existsSync(target) ? readdirSync(target).sort() : null, before);
});
