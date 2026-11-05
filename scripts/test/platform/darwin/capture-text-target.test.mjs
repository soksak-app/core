// The window check setup builds the capture recognizer through a target of the native Makefile, and its unit test uses a fake runner, so this test
// asks make whether the target that the setup names exists.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { captureTextCommand } from "../../../../e2e/platform/darwin/darwin.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

test("the capture recognizer target that the window check setup names exists", { timeout: 30000 }, () => {
  let makeArgs;
  captureTextCommand((name, args) => {
    if (name === "cargo") return { status: 0, stdout: JSON.stringify({ workspace_root: root.replace(/\/$/, "") }), stderr: "" };
    makeArgs = args;
    return { status: 0, stdout: "/work/capture_text_test\n", stderr: "" };
  });
  const target = makeArgs.at(-1);
  const result = spawnSync("make", ["-n", "-C", makeArgs[makeArgs.indexOf("-C") + 1], target], { encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, `make -n ${target}: ${result.stderr}`);
});
