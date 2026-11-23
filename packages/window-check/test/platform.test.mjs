import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { applicationBundle, applicationExecutables, extractApplication, listProcesses, PlatformOperationNotImplemented, quitKeys,
  releasePlatform, waitForLockRelease } from "../platform/platform.mjs";

/** A recorder of the programs that an operation runs: each call answers the next of `outputs`. */
function recorder(...outputs) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    return outputs.shift() ?? "";
  };
  return { calls, run };
}

test("the release platform of the run is the system and the architecture of the computer that runs it", () => {
  assert.equal(releasePlatform({ platform: "darwin", arch: "arm64" }), "darwin-arm64");
  assert.equal(releasePlatform({ platform: "darwin", arch: "x64" }), "darwin-x64");
  assert.equal(releasePlatform({ platform: "linux", arch: "arm64" }), "linux-arm64");
  assert.equal(releasePlatform({ platform: "win32", arch: "x64" }), "windows-x64");
  assert.throws(() => releasePlatform({ platform: "aix", arch: "ppc64" }), /^Error: no release platform for aix-ppc64$/);
  assert.throws(() => releasePlatform({ platform: "darwin", arch: "ia32" }), /^Error: no release platform for darwin-ia32$/);
});

test("on macOS the application of an extracted zip is its bundle, whose Contents/MacOS holds the application and sok", async () => {
  const platform = "darwin";
  assert.equal(await applicationBundle("/c/0.0.41/mygo", { platform }), "/c/0.0.41/mygo/soksak.app");
  assert.deepEqual(await applicationExecutables("/c/soksak.app", "tauriv2", { platform }),
    { application: "/c/soksak.app/Contents/MacOS/sok-tauriv2", sok: "/c/soksak.app/Contents/MacOS/sok" });
  assert.deepEqual(await quitKeys({ platform }), { menu: "cmd+q", key: { key: "q", text: "q", modifiers: ["command"] } });
});

test("on macOS the run extracts with ditto and waits for a lock with lockf", async () => {
  const platform = "darwin";
  const extract = recorder();
  await extractApplication("/c/a.zip", "/c/a.partial", { platform, run: extract.run });
  assert.deepEqual(extract.calls, [["ditto", "-x", "-k", "/c/a.zip", "/c/a.partial"]]);
  const lock = recorder();
  await waitForLockRelease("/r/process.lock", 60, { platform, run: lock.run });
  assert.deepEqual(lock.calls, [["lockf", "-s", "-t", "60", "/r/process.lock", "true"]]);
});

test("the process list holds this process with its command line", async () => {
  const listed = await listProcesses();
  const own = listed.filter((entry) => entry.pid === process.pid);
  assert.equal(own.length, 1, `the list holds ${own.length} records of process ${process.pid}`);
  assert.deepEqual(Object.keys(own[0]), ["pid", "command"]);
  // The test runner starts this file with its own options and with the path as it was given, so the command line starts with the
  // executable of Node and ends with a path of this file.
  assert.ok(own[0].command.startsWith(`${process.execPath} `) && own[0].command.endsWith("platform.test.mjs"),
    `the command line ${own[0].command} names no ${process.execPath} and no platform.test.mjs`);
});

test("an operation that the platform does not implement rejects with its name and runs nothing", async () => {
  for (const platform of ["linux", "win32"]) {
    const { calls, run } = recorder();
    const operations = {
      applicationBundle: () => applicationBundle("/c", { platform }),
      applicationExecutables: () => applicationExecutables("/c/app", "mygo", { platform }),
      extractApplication: () => extractApplication("/c/a.zip", "/c/a", { platform, run }),
      quitKeys: () => quitKeys({ platform }),
      waitForLockRelease: () => waitForLockRelease("/r/process.lock", 60, { platform, run }),
    };
    for (const [operation, call] of Object.entries(operations)) {
      await assert.rejects(call(), (error) => error instanceof PlatformOperationNotImplemented && error.operation === operation
        && error.platform === platform && error.message === `${operation} is not implemented on ${platform}`);
    }
    assert.deepEqual(calls, []);
  }
});

test("the package ships the platform operations of the run", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const file of ["platform/"]) assert.ok(pkg.files.includes(file), `package.json files lists ${file}`);
});
