// Checks installation with real macOS bundle signatures and the native exchange tool.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { table } from "../../../fixtures/bundle-preparation/process-table.mjs";
import { installBundle, prepareBundle } from "../../../../platform/darwin/prepare-app-bundle.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const prepare = (bundle, application) => prepareBundle(bundle, application, { platform: "darwin", run: table([]) });

/** The tool of the installation, built by its make target of native/darwin. */
function swapTool() {
  const built = spawnSync("make", ["-s", "-C", join(ROOT, "native", "darwin"), "build-swap-bundle"], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  return join(ROOT, "native", "darwin", "build", "sok-swap-bundle");
}

/** Signs the bundle ad hoc as the build targets do. */
function sign(bundle) {
  const signed = spawnSync("codesign", ["--sign", "-", "--force", "--deep", bundle], { encoding: "utf8" });
  assert.equal(signed.status, 0, signed.stderr);
}

/** Whether the bundle verifies as the system checks it before it starts it. */
const verifies = (bundle) => spawnSync("codesign", ["--verify", "--deep", "--strict", bundle], { encoding: "utf8" }).status === 0;

/** An installed signed bundle of tauriv2 whose executable is a copy of `executable`. */
function installed(bundle, executable) {
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  copyFileSync(join(ROOT, "apps", "tauriv2", "platform", "darwin", "Info.plist"), join(bundle, "Contents", "Info.plist"));
  copyFileSync(executable, join(bundle, "Contents", "MacOS", "sok-tauriv2"));
  sign(bundle);
}

test("a bundle build leaves the signed bundle unchanged until one rename installs the signed new bundle", { timeout: 60000 }, (t) => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-bundle-install-")));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const bundle = join(temporary, "sok-tauriv2.app");
  installed(bundle, "/usr/bin/true");
  // The signature is written into the executable, so the signed executable of each bundle is the one that it holds after signing.
  const earlier = readFileSync(join(bundle, "Contents", "MacOS", "sok-tauriv2"));
  // After each step of the build the bundle is the complete earlier signed bundle, as a launch at that moment finds it.
  const unchanged = (step) => {
    assert.ok(verifies(bundle), `the bundle does not verify after ${step}`);
    assert.ok(readFileSync(join(bundle, "Contents", "MacOS", "sok-tauriv2")).equals(earlier), `the executable of the bundle changed after ${step}`);
  };
  const staging = prepare(bundle, "tauriv2");
  unchanged("the preparation");
  copyFileSync("/usr/bin/false", join(staging, "Contents", "MacOS", "sok-tauriv2"));
  unchanged("the write of the new executable");
  sign(staging);
  unchanged("the signature of the staging bundle");
  const signed = readFileSync(join(staging, "Contents", "MacOS", "sok-tauriv2"));
  installBundle(bundle, { platform: "darwin", run: table([]), swap: swapTool() });
  assert.ok(verifies(bundle), "the installed bundle does not verify");
  assert.ok(readFileSync(join(bundle, "Contents", "MacOS", "sok-tauriv2")).equals(signed), "the bundle is not the new bundle");
  assert.equal(existsSync(staging), false, "the installation left the earlier bundle at the staging path");
});

test("the installation places the staging bundle at a bundle path that holds no bundle", { timeout: 60000 }, (t) => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-bundle-install-first-")));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const bundle = join(temporary, "sok-tauriv2.app");
  const staging = prepare(bundle, "tauriv2");
  copyFileSync("/usr/bin/true", join(staging, "Contents", "MacOS", "sok-tauriv2"));
  sign(staging);
  installBundle(bundle, { platform: "darwin", run: table([]), swap: swapTool() });
  assert.ok(verifies(bundle), "the installed bundle does not verify");
  assert.equal(existsSync(staging), false, "the installation left the staging bundle");
});

test("the installation refuses a staging bundle that does not verify and leaves the bundle", { timeout: 60000 }, (t) => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-bundle-install-unsigned-")));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const bundle = join(temporary, "sok-tauriv2.app");
  installed(bundle, "/usr/bin/true");
  const earlier = readFileSync(join(bundle, "Contents", "MacOS", "sok-tauriv2"));
  const staging = prepare(bundle, "tauriv2");
  copyFileSync("/usr/bin/false", join(staging, "Contents", "MacOS", "sok-tauriv2"));
  sign(staging);
  writeFileSync(join(staging, "Contents", "Resources", "added-after-signing.txt"), "a file that the signature does not seal\n");
  assert.throws(() => installBundle(bundle, { platform: "darwin", run: table([]), swap: swapTool() }), (error) => {
    assert.ok(error.message.startsWith(`refusing to install ${staging} at ${bundle}: the staging bundle does not verify: `), error.message);
    return true;
  });
  assert.ok(verifies(bundle), "the refused installation changed the bundle");
  assert.ok(readFileSync(join(bundle, "Contents", "MacOS", "sok-tauriv2")).equals(earlier), "the refused installation replaced the bundle");
});

test("the installation refuses a bundle that a process runs before it changes anything", { timeout: 60000 }, (t) => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-bundle-install-running-")));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const bundle = join(temporary, "sok-tauriv2.app");
  installed(bundle, "/usr/bin/true");
  const earlier = readFileSync(join(bundle, "Contents", "MacOS", "sok-tauriv2"));
  const staging = prepare(bundle, "tauriv2");
  copyFileSync("/usr/bin/false", join(staging, "Contents", "MacOS", "sok-tauriv2"));
  sign(staging);
  const executable = join(bundle, "Contents", "MacOS", "sok-tauriv2");
  assert.throws(() => installBundle(bundle, { platform: "darwin", run: table([[4243, executable]]), swap: swapTool() }), (error) => {
    assert.equal(error.message, `refusing to replace bundle ${bundle}: process PID 4243 is executing from its Contents/MacOS directory`);
    return true;
  });
  assert.ok(readFileSync(executable).equals(earlier), "the refused installation replaced the bundle");
  assert.ok(verifies(staging), "the refused installation changed the staging bundle");
});
