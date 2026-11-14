// Runs the bundle preparation of macOS against a disposable bundle. The process table is a recorded `ps -axww -o pid=,command=`
// output that a reader with the signature of spawnSync returns, so the preparation is checked on any system.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareBundle } from "../../../platform/darwin/prepare-app-bundle.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "bundle-preparation");
/** The output buffer of spawnSync when the caller names none. */
const DEFAULT_BUFFER = 1024 * 1024;

/**
 * A process table reader that answers `ps -axww -o pid=,command=` with `rows`, each `[pid, command]`, and fails as spawnSync does
 * when the output exceeds the buffer of the call. It records the calls.
 */
function table(rows, calls = []) {
  return (file, args, options) => {
    calls.push([file, args]);
    const stdout = rows.map(([pid, command]) => `${String(pid).padStart(5)} ${command}\n`).join("");
    const limit = options?.maxBuffer ?? DEFAULT_BUFFER;
    if (Buffer.byteLength(stdout) > limit) {
      return { status: null, stdout: stdout.slice(0, limit), stderr: "", error: Object.assign(new Error(`spawnSync ${file} ENOBUFS`), { code: "ENOBUFS" }) };
    }
    return { status: 0, stdout, stderr: "" };
  };
}

const prepare = (bundle, application, rows = []) => prepareBundle(bundle, application, { platform: "darwin", run: table(rows) });

test("bundle preparation refuses a running bundle executable before removing Contents", { timeout: 10000 }, () => {
  const temporary = mkdtempSync(join(tmpdir(), "soksak-bundle-preparation-"));
  const bundle = join(temporary, "sok-tauriv2.app");
  const contents = join(bundle, "Contents");
  const executable = join(contents, "MacOS", "sok-tauriv2");
  const sentinel = join(contents, "Resources", "preserve-me.txt");
  mkdirSync(dirname(executable), { recursive: true });
  mkdirSync(dirname(sentinel), { recursive: true });
  writeFileSync(executable, "");
  writeFileSync(sentinel, "bundle contents are in use\n");
  const calls = [];
  try {
    assert.throws(() => prepareBundle(bundle, "tauriv2", { platform: "darwin", run: table([[1, "/sbin/launchd"], [4242, executable]], calls) }),
      (error) => {
        assert.match(error.message, /PID 4242/);
        assert.ok(error.message.includes(bundle), `preparation error omitted the bundle path ${bundle}: ${error.message}`);
        return true;
      });
    assert.deepEqual(calls, [["ps", ["-axww", "-o", "pid=,command="]]]);
    assert.ok(existsSync(sentinel), `preparation removed ${sentinel}`);
    assert.ok(existsSync(executable), `preparation removed the running executable ${executable}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("bundle preparation recreates Contents when no process uses the bundle", { timeout: 10000 }, () => {
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
    prepare(bundle, "tauriv2", [[1, "/sbin/launchd"], [77, `${join(temporary, "other.app")}/Contents/MacOS/other`]]);
    assert.equal(existsSync(sentinel), false, "preparation kept old bundle contents");
    assert.ok(existsSync(join(contents, "Info.plist")), "preparation did not write Info.plist");
    assert.ok(existsSync(join(contents, "Resources", "AppIcon.icns")), "preparation did not write the app icon");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("bundle preparation reads the whole process table while other processes carry commands larger than a read buffer", { timeout: 20000 }, (t) => {
  // Three processes carry arguments of 450 KB each, so the commands of all processes exceed the 1 MiB output buffer of spawnSync.
  const large = Array.from({ length: 3 }, (_, index) => [100 + index, `${process.execPath} -e setInterval(() => {}, 1000) ${"x".repeat(450 * 1024)}`]);
  const temporary = mkdtempSync(join(tmpdir(), "soksak-bundle-preparation-large-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const bundle = join(temporary, "sok-tauriv2.app");
  prepare(bundle, "tauriv2", large);
  assert.ok(existsSync(join(bundle, "Contents", "Info.plist")), "preparation did not write Info.plist");
});
