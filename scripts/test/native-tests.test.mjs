// The native tests run one at a time through the test runner (docs/operations/examples.md#test-runner): they open windows, so they
// share the screen, and each one is named when it starts and ends with its elapsed time and has a limit of its own.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
