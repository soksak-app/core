// The core window check finds the application executable in the build output folder that cargo sets and declares it to the harness (F25.1).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cargoCommand } from "@soksak/window-check/cargo.mjs";
import { debugBinaries } from "../setup.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SETUP = JSON.stringify(new URL("../setup.mjs", import.meta.url).href);
/** The build output folder of the repository that the cargo of the toolchain reports. */
const reported = () => JSON.parse(spawnSync(cargoCommand(), ["metadata", "--format-version", "1", "--no-deps"], { cwd: ROOT, encoding: "utf8" }).stdout).target_directory;

test("the target directory is the one cargo metadata reports", { timeout: 60000 }, () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { targetDirectory } from ${SETUP}; process.stdout.write(targetDirectory());`,
  ], { cwd: ROOT, env: process.env, encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, reported());
});

test("the target directory comes from the cargo of the toolchain when the PATH holds no cargo folder", { timeout: 60000 }, () => {
  // The PATH of a shell that did not read the profile, which adds the cargo folder of rustup: the cargo of the toolchain folder runs.
  const env = { HOME: homedir(), PATH: "/usr/bin:/bin", ...(process.env.CARGO_HOME ? { CARGO_HOME: process.env.CARGO_HOME } : {}) };
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { targetDirectory } from ${SETUP}; process.stdout.write(targetDirectory());`,
  ], { cwd: ROOT, env, encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, reported());
});

test("a failed cargo metadata names its exit and output", { timeout: 60000 }, (t) => {
  // A folder that is no part of a Cargo workspace makes cargo metadata fail.
  const empty = mkdtempSync(join(tmpdir(), "setup-no-cargo-toml-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { targetDirectory } from ${SETUP}; targetDirectory();`,
  ], { cwd: empty, env: process.env, encoding: "utf8", timeout: 60000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Error: cargo metadata exited with 101: error: could not find `Cargo.toml` in /);
});

test("each application's executable is the one inside its debug bundle on macOS", async () => {
  assert.deepEqual(await debugBinaries("/work/target", { platform: "darwin" }), {
    SOKSAK_BINARY_WAILSV3: "/work/target/debug/sok-wailsv3.app/Contents/MacOS/sok-wailsv3",
    SOKSAK_BINARY_TAURIV2: "/work/target/debug/sok-tauriv2.app/Contents/MacOS/sok-tauriv2",
    SOKSAK_BINARY_MYGO: "/work/target/debug/sok-mygo.app/Contents/MacOS/sok-mygo",
  });
});

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

for (const platform of ["linux", "win32"]) {
  test(`${platform}: declared binaries allow common setup without native platform preparation`, { timeout: 10000 }, () => {
    // No cargo is reachable: a setup that discovered the binaries or prepared the platform would fail for that.
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const { globalSetup } = await import(${SETUP});
      await globalSetup();
      process.stdout.write(process.env.SOKSAK_BINARY_MYGO);
    `], { encoding: "utf8", timeout: 10000, env: { PATH: "/nonexistent", HOME: "/nonexistent",
      SOKSAK_BINARY_MYGO: "/declared/mygo", SOKSAK_BINARY_WAILSV3: "/declared/wails", SOKSAK_BINARY_TAURIV2: "/declared/tauri" } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "/declared/mygo");
  });
}
