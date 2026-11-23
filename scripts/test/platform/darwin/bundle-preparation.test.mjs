// Runs the bundle preparation of macOS against a disposable bundle, with processes that the test starts from it and ends.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareBundle } from "../../../platform/darwin/prepare-app-bundle.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "bundle-preparation");
const prepare = (bundle, application) => prepareBundle(bundle, application, { platform: "darwin" });

/**
 * Starts a copy of the Node executable that waits at `executable` (or at `launch` from `cwd`), ended when the test ends, and resolves
 * once it executes. A copy of /bin/sleep does not run on a system whose sleep is a program of a multi-call binary, such as the coreutils
 * of Ubuntu 26.04, which ends a copy with another name at once.
 */
async function sleeping(t, executable, { launch = executable, cwd } = {}) {
  mkdirSync(dirname(executable), { recursive: true });
  copyFileSync(process.execPath, executable);
  const child = spawn(launch, ["-e", "setInterval(() => {}, 1000)"], { cwd, stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  await once(child, "spawn");
  return child;
}
/** The staging bundle of `bundle`, `<folder>/.staging/<name>.app` (docs/spec/hosts.md). */
const staged = (bundle) => join(dirname(bundle), ".staging", basename(bundle));

test("bundle preparation refuses a running bundle executable before removing Contents", { timeout: 10000 }, async (t) => {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-bundle-preparation-")));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const bundle = join(temporary, "sok-tauriv2.app");
  const executable = join(bundle, "Contents", "MacOS", "sok-tauriv2");
  const sentinel = join(bundle, "Contents", "Resources", "preserve-me.txt");
  mkdirSync(dirname(sentinel), { recursive: true });
  writeFileSync(sentinel, "bundle contents are in use\n");
  const child = await sleeping(t, executable);
  assert.throws(() => prepare(bundle, "tauriv2"), (error) => {
    assert.match(error.message, new RegExp(`PID ${child.pid}\\b`));
    assert.ok(error.message.includes(bundle), `preparation error omitted the bundle path ${bundle}: ${error.message}`);
    return true;
  });
  assert.ok(existsSync(sentinel), `preparation removed ${sentinel}`);
  assert.ok(existsSync(executable), `preparation removed the running executable ${executable}`);
});

test("bundle preparation creates the Contents of the staging bundle anew and leaves the bundle when no process uses it", { timeout: 10000 }, () => {
  const temporary = mkdtempSync(join(tmpdir(), "soksak-bundle-preparation-idle-"));
  const bundle = join(temporary, "sok-tauriv2.app");
  const contents = join(bundle, "Contents");
  const sentinel = join(contents, "Resources", "remove-me.txt");
  mkdirSync(dirname(sentinel), { recursive: true });
  copyFileSync(join(FIXTURES, "remove-me.txt"), sentinel);
  try {
    // The Makefile prepares a bundle with this script.
    const planned = spawnSync("make", ["-n", "--no-print-directory", "-f", join(ROOT, "Makefile"), "-f", join(FIXTURES, "bundle-preparation.mk"), "bundle-preparation-test", `BUNDLE=${bundle}`], { cwd: ROOT, encoding: "utf8" });
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal(planned.stdout.trim(), `node scripts/platform/darwin/prepare-app-bundle.mjs --bundle "${bundle}" --app "tauriv2"`);
    const earlier = join(staged(bundle), "Contents", "Resources", "remove-me.txt");
    mkdirSync(dirname(earlier), { recursive: true });
    copyFileSync(join(FIXTURES, "remove-me.txt"), earlier);
    assert.equal(prepare(bundle, "tauriv2"), staged(bundle));
    assert.ok(existsSync(sentinel), "preparation changed the bundle");
    assert.equal(existsSync(earlier), false, "preparation kept the contents of an earlier staging bundle");
    assert.ok(existsSync(join(staged(bundle), "Contents", "Info.plist")), "preparation did not write Info.plist");
    assert.ok(existsSync(join(staged(bundle), "Contents", "Resources", "AppIcon.icns")), "preparation did not write the app icon");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("bundle preparation attributes a relative executable path by the working directory of its process", { timeout: 10000 }, async (t) => {
  // Two checkouts build the same relative bundle path; a process of the other checkout was started with that relative path.
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-bundle-preparation-relative-")));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const here = join(temporary, "here");
  const other = join(temporary, "other");
  const relative = "target/debug/sok-mygo.app";
  const launch = `${relative}/Contents/MacOS/sok-mygo`;
  await sleeping(t, join(other, launch), { launch, cwd: other });
  mkdirSync(here, { recursive: true });
  const previous = process.cwd();
  process.chdir(here);
  t.after(() => process.chdir(previous));
  prepare(relative, "mygo");
  assert.ok(existsSync(join(staged(join(here, relative)), "Contents", "Info.plist")), "the process of the other checkout blocked the preparation");
  const child = await sleeping(t, join(here, launch), { launch, cwd: here });
  assert.throws(() => prepare(relative, "mygo"), (error) => {
    assert.match(error.message, new RegExp(`process PID ${child.pid} is executing`));
    assert.ok(error.message.includes(join(here, relative)), error.message);
    return true;
  }, "the process of this checkout did not block the preparation");
});
