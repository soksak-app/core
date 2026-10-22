import assert from "node:assert/strict";
import test from "node:test";

import { runTests } from "../test-runner.mjs";

const node = (name, source, extra = {}) => ({ name, command: process.execPath, args: ["-e", source], timeoutMs: 5000, ...extra });
const sleeping = (ms) => `setTimeout(() => {}, ${ms})`;

async function run(tests, options = {}) {
  const lines = [];
  const outcome = await runTests({ tests, write: (line) => lines.push(line), heartbeatMs: 50, ...options });
  return { ...outcome, lines };
}

test("each test reports its start, its end and its elapsed time, and a failure carries its output", async () => {
  const { results, lines } = await run([
    node("a::passes", "process.exit(0)"),
    node("a::fails", "console.log('the detail'); process.exit(3)"),
  ], { concurrency: 1 });
  assert.equal(results.get("a::passes").status, "pass");
  assert.equal(results.get("a::fails").status, "fail");
  assert.match(lines.find((line) => line.startsWith("RUN  a::passes")), /^RUN  a::passes \(1 running, limit 5\.000s\)$/);
  assert.match(lines.find((line) => line.startsWith("PASS a::passes")), /^PASS a::passes \d+\.\d{3}s$/);
  assert.match(lines.find((line) => line.startsWith("FAIL a::fails")), /^FAIL a::fails \d+\.\d{3}s exit 3$/);
  assert.ok(lines.includes("  the detail"), `the output of the failed test is missing: ${JSON.stringify(lines)}`);
});

test("a test over its own limit is killed and reported as a timeout without holding the others", async () => {
  const { results, lines } = await run([
    node("slow", sleeping(60000), { timeoutMs: 300 }),
    node("quick", "process.exit(0)"),
  ], { concurrency: 2 });
  assert.equal(results.get("slow").status, "timeout");
  assert.equal(results.get("quick").status, "pass");
  // The quick test starts while the hanging test is in flight; the running count of its RUN line shows it.
  assert.match(lines.find((line) => line.startsWith("RUN  quick")), /^RUN  quick \(2 running, limit 5\.000s\)$/);
  assert.match(lines.find((line) => line.startsWith("TIME slow")), /^TIME slow \d+\.\d{3}s exceeded 0\.300s and was killed$/);
});

test("the pool runs at most `concurrency` tests at once and runs them in parallel", async () => {
  const tests = ["a", "b", "c", "d"].map((name) => node(name, sleeping(300)));
  const { lines } = await run(tests, { concurrency: 2 });
  const running = lines.filter((line) => line.startsWith("RUN  ")).map((line) => Number(/\((\d+) running/.exec(line)[1]));
  // The running counts of the RUN lines show the overlap; elapsed time depends on the machine load.
  assert.equal(Math.max(...running), 2);
});

test("a heartbeat names the tests in flight with their running time", async () => {
  // The heartbeat timer is due at 50 ms and the limit timer at 1000 ms; timers of one loop run in the order they are due, so the heartbeat comes first.
  const { lines } = await run([node("long", sleeping(60000), { timeoutMs: 1000 })], { concurrency: 1 });
  const beat = lines.find((line) => line.startsWith("RUNNING 1 test"));
  assert.ok(beat, `no heartbeat: ${JSON.stringify(lines)}`);
  assert.match(beat, /long \d+\.\d{3}s/);
});

test("the summary counts the results and lists the slowest tests, slowest first", async () => {
  const { lines, slowest, results } = await run([
    node("fast", sleeping(10)), node("middle", sleeping(150)), node("slowest", sleeping(300)),
  ], { concurrency: 3, slowCount: 2 });
  // The order follows the measured elapsed times of the results, which depend on the machine load.
  const measured = [...results].sort(([, a], [, b]) => b.elapsedMs - a.elapsedMs).slice(0, 2).map(([name]) => name);
  assert.deepEqual(slowest.map((item) => item.name), measured);
  assert.ok(slowest[0].elapsedMs >= slowest[1].elapsedMs, JSON.stringify(slowest));
  assert.match(lines.at(-1), /^TOTAL 3 tests: 3 pass, 0 fail, 0 timeout in \d+\.\d{3}s$/);
  assert.ok(lines.some((line) => line.startsWith("SLOWEST ")));
});

test("a limit above ten minutes, a missing limit and an empty list are refused", async () => {
  await assert.rejects(runTests({ tests: [node("x", "0", { timeoutMs: 600001 })], concurrency: 1, write() {} }), /600000/);
  // A test without its own limit is refused and named; the runner applies no run-wide limit.
  await assert.rejects(runTests({ tests: [{ name: "x", command: process.execPath, args: ["-e", "0"] }], concurrency: 1, write() {} }), /test x has no timeoutMs/);
  await assert.rejects(runTests({ tests: [], concurrency: 1, write() {} }), /no tests/);
});

test("a test starts only after the gate of the runner opened, and the wait is not part of its limit", async () => {
  const lines = [];
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const calls = [];
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const run = runTests({
    tests: [{ name: "gated", command: process.execPath, args: ["-e", "setTimeout(() => {}, 150)"], timeoutMs: 3000 }],
    concurrency: 1, write: (line) => lines.push(line),
    beforeEach: async (item) => { calls.push(item.name); entered(); await gate; },
  });
  await waiting;
  assert.deepEqual(calls, ["gated"]);
  assert.equal(lines.some((line) => line.startsWith("RUN  gated")), false, "the test started before the gate opened");
  assert.equal(lines.some((line) => line.startsWith("WAIT gated")), true, "the wait is not named");
  open();
  const { results } = await run;
  assert.equal(results.get("gated").status, "pass");
  assert.ok(lines.some((line) => line.startsWith("RUN  gated")));
});

test("a run with a folder gives each test its identifier, stores the output of every test and writes a manifest", async () => {
  const { mkdtempSync, readFileSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = mkdtempSync(join(tmpdir(), "run-"));
  const { results } = await run([
    node("a/passes.test.mjs", "console.log('seen ' + process.env.SOKSAK_RUN_ID + ' in ' + process.env.SOKSAK_RUN_FOLDER)"),
    node("a/fails.test.mjs", "console.error('the detail'); process.exit(3)"),
  ], { concurrency: 1, run: { id: "20261011T000000-1", folder } });
  assert.equal(results.get("a/passes.test.mjs").status, "pass");
  assert.match(results.get("a/passes.test.mjs").output, new RegExp(`seen 20261011T000000-1 in ${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.run, "20261011T000000-1");
  assert.ok(Number.isInteger(manifest.finished_us) && manifest.finished_us >= manifest.started_us, JSON.stringify(manifest));
  assert.deepEqual(manifest.tests.map((item) => [item.name, item.status]), [["a/passes.test.mjs", "pass"], ["a/fails.test.mjs", "fail"]]);
  for (const item of manifest.tests) {
    assert.ok(item.ended_us >= item.started_us && item.started_us >= manifest.started_us, JSON.stringify(item));
    assert.ok(readdirSync(folder).includes(item.output), `${item.output} is not stored`);
  }
  assert.equal(readFileSync(join(folder, manifest.tests[0].output), "utf8"), `seen 20261011T000000-1 in ${folder}\n`);
  assert.match(readFileSync(join(folder, manifest.tests[1].output), "utf8"), /^the detail\n$/);
});

test("a manifest names a test that is still running, so a run that stops leaves the test it stopped in", async () => {
  const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = mkdtempSync(join(tmpdir(), "run-"));
  const lines = [];
  let during = null;
  // A heartbeat line names the test in flight, and the runner saves the manifest before it starts the test, so the manifest is read at the first heartbeat.
  const pending = runTests({
    tests: [node("slow", sleeping(60000), { timeoutMs: 1500 })], concurrency: 1,
    write: (line) => {
      lines.push(line);
      if (during === null && line.startsWith("RUNNING 1 test")) {
        assert.ok(existsSync(join(folder, "manifest.json")), "the run wrote no manifest while its test was running");
        during = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
      }
    },
    heartbeatMs: 50, run: { id: "r-1", folder },
  });
  await pending;
  assert.ok(during, `no heartbeat while the test was running: ${JSON.stringify(lines)}`);
  assert.deepEqual(during.tests.map((item) => [item.name, item.status]), [["slow", "running"]]);
  assert.equal(during.finished_us, null);
  assert.equal(JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")).tests[0].status, "timeout");
});

// A fixture test file of node --test in a temporary folder. The file runs under the environment of this test run without NODE_TEST_CONTEXT,
// which would make node --test skip it (the same variable that node-tests.test.mjs removes).
async function nodeTestFile(source) {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = mkdtempSync(join(tmpdir(), "runner-handle-"));
  const file = join(folder, "handle.test.mjs");
  writeFileSync(file, source);
  return { folder, file };
}

test("a test file that leaves a timer open after its tests pass is ended at its limit, and the timeout names the process that remains", async () => {
  const { rmSync } = await import("node:fs");
  const { file, folder } = await nodeTestFile('import test from "node:test";\ntest("passes", () => {});\nsetInterval(() => {}, 1000);\n');
  try {
    const { results } = await run([
      { name: "handle", command: "/usr/bin/env", args: ["-u", "NODE_TEST_CONTEXT", process.execPath, "--test", file], timeoutMs: 4000 },
    ], { concurrency: 1, defaultTimeoutMs: 4000 });
    const result = results.get("handle");
    assert.equal(result.status, "timeout", result.output);
    assert.match(result.detail, /^exceeded 4\.000s and was killed; left running: pid \d+ .*handle\.test\.mjs$/, result.detail);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a process that outlives its test process is ended at that exit, and the failure names it", async () => {
  // The child inherits the output pipes, so the output closes only when the child ends. The child is unreferenced, so the test process
  // exits with 0 while the child runs.
  const source = `const child = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); child.unref(); console.log("left");`;
  const { results } = await run([
    { name: "outlives", command: process.execPath, args: ["-e", source], timeoutMs: 20000 },
  ], { concurrency: 1, defaultTimeoutMs: 20000 });
  const result = results.get("outlives");
  assert.equal(result.status, "fail", result.detail);
  assert.match(result.detail, /^left running after exit: pid \d+ /, result.detail);
  assert.ok(result.elapsedMs < 15000, `the process ran ${result.elapsedMs} ms, to its limit instead of its exit`);
});
