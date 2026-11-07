// The window check setup builds the capture recognizer through a target of the native Makefile, and its unit test uses a fake runner, so this test
// asks make whether the target that the setup names exists.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { captureTextCommand } from "../../../../e2e/platform/darwin/darwin.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

test("the accurate capture recognizer reports its public supported compute devices", { timeout: 30000 }, () => {
  const built = spawnSync("make", ["-s", "-C", `${root}native/darwin`, "build-capture-text-path"], { encoding: "utf8", timeout: 20000 });
  assert.equal(built.status, 0, built.stderr);
  const binary = built.stdout.trim().split("\n").at(-1);
  const result = spawnSync(binary, ["--compute-devices"], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.recognitionLevel, "accurate");
  assert.equal(report.usesLanguageCorrection, false);
  assert.ok(Number.isInteger(report.revision) && report.revision > 0);
  assert.ok(Object.keys(report.stages).length > 0);
  for (const devices of Object.values(report.stages)) {
    assert.ok(Array.isArray(devices) && devices.length > 0);
    for (const device of devices) assert.ok(["cpu", "gpu", "neuralEngine"].includes(device), device);
  }
});

test("the capture recognizer target that the window check setup names exists", { timeout: 30000 }, () => {
  let makeArgs;
  captureTextCommand((name, args) => {
    if (name === "cargo") return { status: 0, stdout: JSON.stringify({ workspace_root: root.replace(/\/$/, "") }), stderr: "" };
    makeArgs = args;
    return { status: 0, stdout: "/work/capture_text_test\n", stderr: "" };
  }, () => "cargo");
  const target = makeArgs.at(-1);
  const result = spawnSync("make", ["-n", "-C", makeArgs[makeArgs.indexOf("-C") + 1], target], { encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, `make -n ${target}: ${result.stderr}`);
});
