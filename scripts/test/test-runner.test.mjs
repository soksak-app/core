import assert from "node:assert/strict";
import test from "node:test";

import { runTests } from "../test-runner.mjs";

const node = (name, source, extra = {}) => ({ name, command: process.execPath, args: ["-e", source], ...extra });
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
  ], { concurrency: 1, defaultTimeoutMs: 5000 });
  assert.equal(results.get("a::passes").status, "pass");
  assert.equal(results.get("a::fails").status, "fail");
  assert.match(lines.find((line) => line.startsWith("RUN  a::passes")), /^RUN  a::passes \(1 running\)$/);
  assert.match(lines.find((line) => line.startsWith("PASS a::passes")), /^PASS a::passes \d+\.\d{3}s$/);
  assert.match(lines.find((line) => line.startsWith("FAIL a::fails")), /^FAIL a::fails \d+\.\d{3}s exit 3$/);
  assert.ok(lines.includes("  the detail"), `the output of the failed test is missing: ${JSON.stringify(lines)}`);
});

test("a test over its own limit is killed and reported as a timeout without holding the others", async () => {
  const started = performance.now();
  const { results, lines } = await run([
    node("slow", sleeping(60000), { timeoutMs: 300 }),
    node("quick", "process.exit(0)"),
  ], { concurrency: 2, defaultTimeoutMs: 5000 });
  assert.equal(results.get("slow").status, "timeout");
  assert.equal(results.get("quick").status, "pass");
  assert.ok(performance.now() - started < 5000, "the run waited for the hanging test");
  assert.match(lines.find((line) => line.startsWith("TIME slow")), /^TIME slow \d+\.\d{3}s exceeded 0\.300s and was killed$/);
});

test("the pool runs at most `concurrency` tests at once and runs them in parallel", async () => {
  const tests = ["a", "b", "c", "d"].map((name) => node(name, sleeping(300)));
  const started = performance.now();
  const { lines } = await run(tests, { concurrency: 2, defaultTimeoutMs: 5000 });
  const elapsed = performance.now() - started;
  const running = lines.filter((line) => line.startsWith("RUN  ")).map((line) => Number(/\((\d+) running\)/.exec(line)[1]));
  assert.equal(Math.max(...running), 2);
  assert.ok(elapsed >= 550, `four tests of 300 ms in a pool of two took ${elapsed} ms`);
  assert.ok(elapsed < 1150, `the pool did not run in parallel: ${elapsed} ms`);
});

test("a heartbeat names the tests in flight with their running time", async () => {
  const { lines } = await run([node("long", sleeping(400))], { concurrency: 1, defaultTimeoutMs: 5000 });
  const beat = lines.find((line) => line.startsWith("RUNNING 1 test"));
  assert.ok(beat, `no heartbeat: ${JSON.stringify(lines)}`);
  assert.match(beat, /long \d+\.\d{3}s/);
});

test("the summary counts the results and lists the slowest tests, slowest first", async () => {
  const { lines, slowest } = await run([
    node("fast", sleeping(10)), node("middle", sleeping(150)), node("slowest", sleeping(300)),
  ], { concurrency: 3, defaultTimeoutMs: 5000, slowCount: 2 });
  assert.deepEqual(slowest.map((item) => item.name), ["slowest", "middle"]);
  assert.match(lines.at(-1), /^TOTAL 3 tests: 3 pass, 0 fail, 0 timeout in \d+\.\d{3}s$/);
  assert.ok(lines.some((line) => line.startsWith("SLOWEST ")));
});

test("a limit above ten minutes, a missing limit and an empty list are refused", async () => {
  await assert.rejects(runTests({ tests: [node("x", "0", { timeoutMs: 600001 })], concurrency: 1, defaultTimeoutMs: 1000, write() {} }), /600000/);
  await assert.rejects(runTests({ tests: [node("x", "0")], concurrency: 1, write() {} }), /defaultTimeoutMs/);
  await assert.rejects(runTests({ tests: [], concurrency: 1, defaultTimeoutMs: 1000, write() {} }), /no tests/);
});
