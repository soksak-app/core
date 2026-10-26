// The native tests run one at a time through the test runner (docs/operations/examples.md#test-runner): they open windows, so they
// share the screen, and each one is named when it starts and ends with its elapsed time and has a limit of its own.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { nativeTests, runNativeTests } from "../native-tests.mjs";

const build = () => {
  const dir = mkdtempSync(join(tmpdir(), "native-tests-"));
  const script = (name, body) => {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  return { dir, script };
};

test("a native test is an executable of the build folder with optional arguments", () => {
  assert.deepEqual(nativeTests("/b", ["a_test", "app/x,--bundled"]), [
    { name: "a_test", command: "/b/a_test", args: [] },
    { name: "app/x --bundled", command: "/b/app/x", args: ["--bundled"] },
  ]);
  assert.throws(() => nativeTests("/b", []), /there is no native test to run/);
  assert.throws(() => nativeTests("/b", ["a_test", "a_test"]), /the native test a_test is listed twice/);
});

test("the activation target builds and runs its cases through the native test runner", () => {
  const darwin = new URL("../../native/darwin/", import.meta.url);
  const temporary = mkdtempSync(join(tmpdir(), "native-activation-contract-"));
  const buildDir = join(temporary, "build");
  mkdirSync(buildDir, { recursive: true });
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const library = join(buildDir, "libsoksak-darwin.a");
  writeFileSync(library, "");
  utimesSync(library, future, future);
  for (const name of [
    "input_activate_test",
    "webview_input_test",
    "webview_inspector_test",
    "window_fullscreen_test",
    "document_view_test",
    "image_region_ime_test",
    "view_focus_test",
  ]) {
    const path = join(buildDir, name);
    writeFileSync(path, "");
    utimesSync(path, future, future);
  }

  const output = execFileSync("make", [
    "-n",
    "-o",
    library,
    "-C",
    darwin.pathname,
    `BUILD=${buildDir}`,
    "test-activation",
  ], { encoding: "utf8" });
  const lines = output.split("\n");
  const runnerLines = lines.filter((line) => line.includes("native-tests.mjs"));
  assert.equal(runnerLines.length, 1, output);
  const runnerArgs = runnerLines[0].trim().split(/\s+/).slice(2);
  assert.equal(runnerArgs[0], buildDir);
  assert.deepEqual(runnerArgs.slice(1), [
    "input_activate_test",
    "webview_inspector_test",
    "window_fullscreen_test",
    "webview_input_test,--baseline",
    "webview_input_test",
    "document_view_test,--activation",
    "image_region_test,--activation",
    "image_region_ime_test",
    "view_focus_test,--activation",
  ]);
  assert.ok(
    lines.some((line) => line.includes(`-o ${buildDir}/image_region_test`)),
    "the activation target does not build image_region_test before running it",
  );
  assert.deepEqual(lines.filter((line) => /^\s*@?[^ ]*\/[^ ]+_test(?:\s|$)/.test(line)), [], output);
});

test("the native tests run one at a time, each with its start and end, and a failure fails the run", async () => {
  const { dir, script } = build();
  script("ok_test", "echo fine");
  script("bad_test", "echo broken >&2; exit 3");
  const lines = [];
  const code = await runNativeTests({ dir, list: ["ok_test", "bad_test"], timeoutMs: 20000, write: (line) => lines.push(line) });
  assert.equal(code, 1);
  const marks = lines.filter((line) => /^(RUN|PASS|FAIL|TIME)/.test(line)).map((line) => line.replace(/ \(\d+ running, limit [0-9.]+s\)$/, "").replace(/ [0-9.]+s.*$/, ""));
  assert.deepEqual(marks, ["RUN  ok_test", "PASS ok_test", "RUN  bad_test", "FAIL bad_test"]);
  assert.ok(lines.includes("  broken"), "the output of the failed test follows its line");
});

test("a successful native child keeps its stdout in the requested run record", async () => {
  const { dir, script } = build();
  const runFolder = join(dir, "run");
  script("ok_test", "echo checkpoint=outer-restored source=ABC");
  const lines = [];
  const code = await runNativeTests({ dir, list: ["ok_test"], run: { id: "run", folder: runFolder },
    timeoutMs: 20000, write: (line) => lines.push(line) });
  assert.equal(code, 0, JSON.stringify(lines));
  const manifest = JSON.parse(readFileSync(join(runFolder, "manifest.json"), "utf8"));
  assert.equal(manifest.tests.length, 1);
  assert.equal(manifest.tests[0].status, "pass");
  assert.match(readFileSync(join(runFolder, manifest.tests[0].output), "utf8"), /checkpoint=outer-restored source=ABC/);
});

test("a native test over its limit is killed and fails the run", async () => {
  const { dir, script } = build();
  script("slow_test", "sleep 30");
  const lines = [];
  const code = await runNativeTests({ dir, list: ["slow_test"], timeoutMs: 300, write: (line) => lines.push(line) });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => /^TIME slow_test [0-9.]+s exceeded 0\.300s and was killed(?:; left running: .*)?$/.test(line)), JSON.stringify(lines));
});
