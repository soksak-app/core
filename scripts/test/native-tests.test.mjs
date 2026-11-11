// The native tests run one at a time through the test runner (docs/operations/examples.md#test-parity): they open windows, so they
// share the screen, and each one is named when it starts and ends with its elapsed time and has a limit of its own.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

test("the default native suite runs the standalone host test API", () => {
  const darwin = new URL("../../native/darwin/", import.meta.url);
  const output = execFileSync("make", ["-n", "-C", darwin.pathname, "test"], { encoding: "utf8" });
  const runs = output.split("\n").filter((line) => line.startsWith("node ") && line.includes("scripts/native-tests.mjs"));
  assert.equal(runs.length, 1, output);
  assert.match(runs[0], /(?:^|\s)host_test_api_test(?:\s|$)/, "the default native run omits the standalone test API");
  assert.match(runs[0], /(?:^|\s)input_activate_test(?:\s|$)/, "the default native run omits the emulated activation");
  // A check that activates a window does it with the emulated activation of sp_input_activate, which leaves the process inactive,
  // so it runs in the default suite (F756).
  for (const entry of ["view_focus_test,--activation", "document_view_test,--activation", "image_region_test,--activation", "webview_inspector_test", "webview_input_test"]) {
    assert.ok(runs[0].split(/\s+/).includes(entry), `the default native run omits the emulated activation of ${entry}`);
  }
});

test("the activation target builds and runs its cases through the native test runner", (t) => {
  const darwin = new URL("../../native/darwin/", import.meta.url);
  const temporary = mkdtempSync(join(tmpdir(), "native-activation-contract-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const buildDir = join(temporary, "build");
  mkdirSync(buildDir, { recursive: true });
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const library = join(buildDir, "libsoksak-darwin.a");
  writeFileSync(library, "");
  utimesSync(library, future, future);
  for (const name of [
    "webview_input_test",
    "webview_inspector_test",
    "window_fullscreen_test",
    "document_view_test",
    "image_region_ime_test",
    "view_focus_test",
    "input_virtual_ime_test",
    "ime_person_app",
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
    "test-app-activation",
  ], { encoding: "utf8" });
  const lines = output.split("\n");
  const runnerLines = lines.filter((line) => line.includes("native-tests.mjs"));
  assert.equal(runnerLines.length, 1, output);
  // The recipe is `[NAME="value" ...] node <runner> <build> <case>...`: the environment the cases read, then the runner.
  const words = runnerLines[0].trim().split(/\s+/);
  const environment = {};
  while (/^[A-Z_][A-Z0-9_]*=/.test(words[0])) {
    const [name, ...value] = words.shift().split("=");
    environment[name] = value.join("=").replace(/^"(.*)"$/, "$1");
  }
  // The input method check of the virtual key window starts the person's application that the target builds.
  assert.deepEqual(environment, { SOKSAK_IME_PERSON_APP: join(buildDir, "ime_person_app") }, runnerLines[0]);
  assert.equal(words[0], "node", runnerLines[0]);
  assert.match(words[1], /\/scripts\/native-tests\.mjs$/, runnerLines[0]);
  const runnerArgs = words.slice(2);
  assert.equal(runnerArgs[0], buildDir);
  assert.deepEqual(runnerArgs.slice(1), [
    "window_fullscreen_test",
    "webview_input_test,--monitor",
    "image_region_ime_test",
    "input_virtual_ime_test",
  ]);
  assert.deepEqual(lines.filter((line) => /^\s*@?[^ ]*\/[^ ]+_test(?:\s|$)/.test(line)), [], output);
});

test("the native tests run one at a time, each with its start and end, and a failure fails the run", async (t) => {
  const { dir, script } = build();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  script("ok_test", "echo fine");
  script("bad_test", "echo broken >&2; exit 3");
  const lines = [];
  const code = await runNativeTests({ dir, list: ["ok_test", "bad_test"], timeoutMs: 20000, write: (line) => lines.push(line) });
  assert.equal(code, 1);
  const marks = lines.filter((line) => /^(RUN|PASS|FAIL|TIME)/.test(line)).map((line) => line.replace(/ \(\d+ running, limit [0-9.]+s\)$/, "").replace(/ [0-9.]+s.*$/, ""));
  assert.deepEqual(marks, ["RUN  ok_test", "PASS ok_test", "RUN  bad_test", "FAIL bad_test"]);
  assert.ok(lines.includes("  broken"), "the output of the failed test follows its line");
});

test("a successful native child keeps its stdout in the requested run record", async (t) => {
  const { dir, script } = build();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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

test("a native test over its limit is killed and fails the run", async (t) => {
  const { dir, script } = build();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  script("slow_test", "sleep 30");
  const lines = [];
  const code = await runNativeTests({ dir, list: ["slow_test"], timeoutMs: 300, write: (line) => lines.push(line) });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => /^TIME slow_test [0-9.]+s exceeded 0\.300s and was killed(?:; left running: .*)?$/.test(line)), JSON.stringify(lines));
});
