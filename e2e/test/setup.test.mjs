// The core window check finds the application executable in the build output folder that cargo sets and declares it to the harness (F25.1).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cargoCommand } from "@soksak/window-check/cargo.mjs";

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

test("the target directory comes from the cargo of the toolchain when the PATH holds no cargo folder", { timeout: 60000 }, (t) => {
  // The PATH of a shell that did not read the profile, which adds the cargo folder of rustup. The toolchain folder of a temporary
  // CARGO_HOME holds the cargo that this process resolves, linked as rustup links the cargo of a toolchain, so that folder's cargo runs.
  const cargoHome = mkdtempSync(join(tmpdir(), "setup-cargo-home-"));
  t.after(() => rmSync(cargoHome, { recursive: true, force: true }));
  mkdirSync(join(cargoHome, "bin"));
  symlinkSync(cargoCommand(), join(cargoHome, "bin", "cargo"));
  const env = { HOME: homedir(), PATH: "/usr/bin:/bin", CARGO_HOME: cargoHome };
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
  assert.match(result.stderr, /Error: cargo metadata exited with 101: error: could not find `Cargo.toml` in `\/.+ or any parent directory/);
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
