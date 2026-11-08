// The core window check finds the application executable in the build output folder that cargo sets and declares it to the harness (F25.1).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { debugBinaries, targetDirectory } from "../setup.mjs";

// The cargo that the functions run when a test gives it.
const CARGO = "/toolchain/bin/cargo";
const cargo = () => CARGO;

test("the target directory is the one cargo metadata reports", () => {
  const calls = [];
  const directory = targetDirectory((command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: JSON.stringify({ target_directory: "/work/target" }), stderr: "" };
  }, cargo);
  assert.equal(directory, "/work/target");
  assert.deepEqual(calls, [[CARGO, "metadata", "--format-version", "1", "--no-deps"]]);
});

test("the target directory comes from the cargo of the toolchain when the PATH holds no cargo folder", { timeout: 60000 }, () => {
  // The PATH of a shell that did not read the profile, which adds the cargo folder of rustup; cargo metadata builds nothing.
  const env = { HOME: homedir(), PATH: "/usr/bin:/bin", ...(process.env.CARGO_HOME ? { CARGO_HOME: process.env.CARGO_HOME } : {}) };
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { targetDirectory } from ${JSON.stringify(new URL("../setup.mjs", import.meta.url).href)}; process.stdout.write(targetDirectory());`,
  ], { cwd: fileURLToPath(new URL("../../", import.meta.url)), env, encoding: "utf8", timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(isAbsolute(result.stdout), result.stdout);
});

test("a failed cargo metadata names its exit and output", () => {
  assert.throws(() => targetDirectory(() => ({ status: 101, stdout: "", stderr: "could not find Cargo.toml\n" }), cargo),
    /^Error: cargo metadata exited with 101: could not find Cargo.toml$/);
});

test("each application's executable is the one inside its debug bundle", () => {
  assert.deepEqual(debugBinaries("/work/target"), {
    SOKSAK_BINARY_WAILSV3: "/work/target/debug/sok-wailsv3.app/Contents/MacOS/sok-wailsv3",
    SOKSAK_BINARY_TAURIV2: "/work/target/debug/sok-tauriv2.app/Contents/MacOS/sok-tauriv2",
    SOKSAK_BINARY_MYGO: "/work/target/debug/sok-mygo.app/Contents/MacOS/sok-mygo",
  });
});

test("common setup declares binaries without building anything", { timeout: 10000 }, () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import childProcess from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    childProcess.spawnSync = (command, args) => {
      if (args[0] !== "metadata") throw new Error("unexpected setup dependency: " + command + " " + args.join(" "));
      return { status: 0, stdout: JSON.stringify({ target_directory: "/declared/target", workspace_root: "/declared/source" }) };
    };
    syncBuiltinESMExports();
    const { globalSetup } = await import(${JSON.stringify(new URL("../setup.mjs", import.meta.url).href)});
    await globalSetup();
    process.stdout.write(JSON.stringify({ binary: process.env.SOKSAK_BINARY_MYGO }));
  `], { encoding: "utf8", timeout: 10000, env: Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith("SOKSAK_BINARY_"))) });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { binary: "/declared/target/debug/sok-mygo.app/Contents/MacOS/sok-mygo" });
});


for (const platform of ["linux", "win32"]) {
  test(`${platform}: declared binaries allow common setup without native platform preparation`, { timeout: 10000 }, () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });
      childProcess.spawnSync = () => { throw new Error("declared binaries must need no discovery or native preparation"); };
      syncBuiltinESMExports();
      const { globalSetup } = await import(${JSON.stringify(new URL("../setup.mjs", import.meta.url).href)});
      await globalSetup();
      process.stdout.write(process.env.SOKSAK_BINARY_MYGO);
    `], { encoding: "utf8", timeout: 10000, env: { ...process.env,
      SOKSAK_BINARY_MYGO: "/declared/mygo", SOKSAK_BINARY_WAILSV3: "/declared/wails", SOKSAK_BINARY_TAURIV2: "/declared/tauri" } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "/declared/mygo");
  });
}
