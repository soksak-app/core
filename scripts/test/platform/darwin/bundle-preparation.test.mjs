// Runs the bundle preparation of macOS against a disposable bundle. The process table is a recorded `ps -axww -o pid=,command=`
// output that a reader with the signature of spawnSync returns, so the preparation is checked on any system.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as preparation from "../../../platform/darwin/prepare-app-bundle.mjs";

const { prepareBundle } = preparation;

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
/** The staging bundle of `bundle`, `<folder>/.staging/<name>.app` (docs/spec/hosts.md). */
const staged = (bundle) => join(dirname(bundle), ".staging", basename(bundle));

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
    assert.equal(prepare(bundle, "tauriv2", [[1, "/sbin/launchd"], [77, `${join(temporary, "other.app")}/Contents/MacOS/other`]]), staged(bundle));
    assert.ok(existsSync(sentinel), "preparation changed the bundle");
    assert.equal(existsSync(earlier), false, "preparation kept the contents of an earlier staging bundle");
    assert.ok(existsSync(join(staged(bundle), "Contents", "Info.plist")), "preparation did not write Info.plist");
    assert.ok(existsSync(join(staged(bundle), "Contents", "Resources", "AppIcon.icns")), "preparation did not write the app icon");
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
  assert.ok(existsSync(join(staged(bundle), "Contents", "Info.plist")), "preparation did not write Info.plist");
});

test("bundle preparation attributes a relative executable path by the working directory of its process", { timeout: 10000 }, () => {
  // Two checkouts build the same relative bundle path; a process of the other checkout was started with that relative path.
  // lsof reports the resolved path of a working directory, as the working directory of this process is.
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "soksak-bundle-preparation-relative-")));
  const here = join(temporary, "here");
  const other = join(temporary, "other");
  const relative = "target/debug/sok-mygo.app";
  const command = `${relative}/Contents/MacOS/sok-mygo --config-dir /tmp/check`;
  // The process table and the working directory of each process, as `lsof -a -p <pid> -d cwd -Fn` reports it.
  const cwds = { 31: other, 32: here };
  const reader = (rows, calls) => {
    const ps = table(rows, calls);
    return (file, args, options) => {
      if (file !== "lsof") return ps(file, args, options);
      calls.push([file, args]);
      const pid = Number(args[args.indexOf("-p") + 1]);
      return { status: 0, stdout: `p${pid}\nfcwd\nn${cwds[pid]}\n`, stderr: "" };
    };
  };
  const previous = process.cwd();
  mkdirSync(here, { recursive: true });
  process.chdir(here);
  try {
    const calls = [];
    prepareBundle(relative, "mygo", { platform: "darwin", run: reader([[31, command]], calls) });
    assert.ok(existsSync(join(staged(join(here, relative)), "Contents", "Info.plist")), "the process of the other checkout blocked the preparation");
    assert.deepEqual(calls.filter(([file]) => file === "lsof"), [["lsof", ["-a", "-p", "31", "-d", "cwd", "-Fn"]]]);
    assert.throws(() => prepareBundle(relative, "mygo", { platform: "darwin", run: reader([[31, command], [32, command]], []) }),
      (error) => {
        assert.match(error.message, /process PID 32 is executing/);
        assert.ok(error.message.includes(join(here, relative)), error.message);
        return true;
      }, "the process of this checkout did not block the preparation");
  } finally {
    process.chdir(previous);
    rmSync(temporary, { recursive: true, force: true });
  }
});

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
  preparation.installBundle(bundle, { platform: "darwin", run: table([]), swap: swapTool() });
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
  preparation.installBundle(bundle, { platform: "darwin", run: table([]), swap: swapTool() });
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
  assert.throws(() => preparation.installBundle(bundle, { platform: "darwin", run: table([]), swap: swapTool() }), (error) => {
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
  assert.throws(() => preparation.installBundle(bundle, { platform: "darwin", run: table([[4243, executable]]), swap: swapTool() }), (error) => {
    assert.equal(error.message, `refusing to replace bundle ${bundle}: process PID 4243 is executing from its Contents/MacOS directory`);
    return true;
  });
  assert.ok(readFileSync(executable).equals(earlier), "the refused installation replaced the bundle");
  assert.ok(verifies(staging), "the refused installation changed the staging bundle");
});
