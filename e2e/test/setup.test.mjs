// The core window check finds the application executable in the build output folder that cargo sets and declares it to the harness (F25.1).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CAPTURE_TEXT_LANGUAGES } from "../view-content.mjs";
import { captureTextCommand, debugBinaries, targetDirectory, warmCaptureText } from "../setup.mjs";

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

test("capture recognition resolves its executable through the native build target", { timeout: 5000 }, () => {
  const calls = [];
  const command = captureTextCommand((name, args) => {
    calls.push([name, ...args]);
    return { status: 0, stdout: name === CARGO ? JSON.stringify({ workspace_root: "/work/project" })
      : "/work/native-output/capture_text_test\n", stderr: "" };
  }, cargo);
  assert.equal(command, "/work/native-output/capture_text_test");
  assert.deepEqual(calls[1], ["make", "--no-print-directory", "-s", "-C", "/work/project/native/darwin", "build-capture-text-path"]);
});

test("capture recognition preserves a native build failure", { timeout: 5000 }, () => {
  assert.throws(() => captureTextCommand(name => name === CARGO
    ? { status: 0, stdout: JSON.stringify({ workspace_root: "/work/project" }), stderr: "" }
    : { status: 2, stdout: "", stderr: "compiler failed" }, cargo), /capture text build exited with 2: compiler failed/);
});

test("the warm-up recognizes each recognition language once in a process of its own before the checks", { timeout: 5000 }, () => {
  const calls = [];
  const report = warmCaptureText("/work/native-output/capture_text_test", CAPTURE_TEXT_LANGUAGES, (name, args) => {
    calls.push([name, ...args]);
    return { status: 0, stdout: "", stderr: "warmed en-US in 1.000s\nwarmed ko-KR in 2.000s\n" };
  });
  assert.deepEqual(CAPTURE_TEXT_LANGUAGES, ["en-US", "ko-KR"]);
  assert.deepEqual(calls, [["/work/native-output/capture_text_test", "--warm", "en-US", "ko-KR"]]);
  assert.equal(report, "warmed en-US in 1.000s\nwarmed ko-KR in 2.000s");
});

test("a warm-up that fails or exceeds its limit fails the setup with its cause", { timeout: 5000 }, () => {
  const command = "/work/native-output/capture_text_test";
  assert.throws(() => warmCaptureText(command, ["en-US"], () => ({ status: 3, stdout: "",
    stderr: "error: the system text recognizer failed: e5rt 13\n" })),
  /^Error: capture text warm-up exited with 3: error: the system text recognizer failed: e5rt 13$/);
  assert.throws(() => warmCaptureText(command, ["en-US", "ko-KR"], () => ({ status: null,
    error: Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" }) })),
  /^Error: capture text warm-up of en-US, ko-KR exceeded 600000 ms$/);
  assert.throws(() => warmCaptureText(command, ["en-US"], () => ({ status: null, error: new Error("spawnSync ENOENT") })),
    /^Error: capture text warm-up: spawnSync ENOENT$/);
  assert.throws(() => warmCaptureText(command, [], () => assert.fail("no language runs no warm-up")), /needs at least one language/);
});
