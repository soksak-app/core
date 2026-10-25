// The core window check finds the application executable in the build output folder that cargo sets and declares it to the harness (F25.1).
import assert from "node:assert/strict";
import test from "node:test";
import { captureTextCommand, debugBinaries, targetDirectory } from "../setup.mjs";

test("the target directory is the one cargo metadata reports", () => {
  const calls = [];
  const directory = targetDirectory((command, args) => {
    calls.push([command, ...args]);
    return { status: 0, stdout: JSON.stringify({ target_directory: "/work/target" }), stderr: "" };
  });
  assert.equal(directory, "/work/target");
  assert.deepEqual(calls, [["cargo", "metadata", "--format-version", "1", "--no-deps"]]);
});

test("a failed cargo metadata names its exit and output", () => {
  assert.throws(() => targetDirectory(() => ({ status: 101, stdout: "", stderr: "could not find Cargo.toml\n" })),
    /^Error: cargo metadata exited with 101: could not find Cargo.toml$/);
});

test("each application's executable is the one inside its debug bundle", () => {
  assert.deepEqual(debugBinaries("/work/target"), {
    SOKSAK_BINARY_WAILSV3: "/work/target/debug/soksak-wailsv3.app/Contents/MacOS/soksak-wailsv3",
    SOKSAK_BINARY_TAURIV2: "/work/target/debug/soksak-tauriv2.app/Contents/MacOS/soksak-tauriv2",
  });
});

test("capture recognition resolves its executable through the native build target", { timeout: 5000 }, () => {
  const calls = [];
  const command = captureTextCommand((name, args) => {
    calls.push([name, ...args]);
    return { status: 0, stdout: name === "cargo" ? JSON.stringify({ workspace_root: "/work/project" })
      : "/work/native-output/capture_text_test\n", stderr: "" };
  });
  assert.equal(command, "/work/native-output/capture_text_test");
  assert.deepEqual(calls[1], ["make", "--no-print-directory", "-s", "-C", "/work/project/native/darwin", "capture-text-path"]);
});

test("capture recognition preserves a native build failure", { timeout: 5000 }, () => {
  assert.throws(() => captureTextCommand(name => name === "cargo"
    ? { status: 0, stdout: JSON.stringify({ workspace_root: "/work/project" }), stderr: "" }
    : { status: 2, stdout: "", stderr: "compiler failed" }), /capture text build exited with 2: compiler failed/);
});
