import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import childProcess, { spawn, spawnSync } from "node:child_process";
import test from "node:test";

import { EVENT_PREFIX } from "../test-event-reporter.mjs";
import { killGroup, runTests, stopGroup } from "../test-runner.mjs";

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

test("a limit above ten minutes, a limit that is not an integer and an empty list are refused", async () => {
  await assert.rejects(runTests({ tests: [node("x", "0", { timeoutMs: 600001 })], concurrency: 1, write() {} }), /600000/);
  await assert.rejects(runTests({ tests: [node("x", "0", { timeoutMs: 1.5 })], concurrency: 1, write() {} }), /x: timeoutMs must be an integer/);
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

test("a test over its limit with a stack signal receives that signal first, and its output keeps what it printed on the signal", async () => {
  // The process prints its stacks on SIGQUIT and exits, as a Go test binary does; a runner that kills the group without the signal
  // leaves the output without the stacks.
  const source = `process.on("SIGQUIT", () => { console.log("goroutine 1 [the stacks]"); process.exit(2); }); console.log("waiting"); ${sleeping(60000)}`;
  const { results, lines } = await run([node("hangs", source, { timeoutMs: 1000, stackSignal: "SIGQUIT" })], { concurrency: 1 });
  const result = results.get("hangs");
  assert.equal(result.status, "timeout", result.detail);
  assert.match(result.output, /^goroutine 1 \[the stacks\]$/m, result.output);
  assert.match(lines.find((line) => line.startsWith("TIME hangs")), /^TIME hangs \d+\.\d{3}s exceeded 1\.000s and was sent SIGQUIT for its stacks$/);
  assert.ok(result.elapsedMs < 5000, `the test ran ${result.elapsedMs} ms against its limit of 1000 ms`);
});

test("a test over its limit that does not exit on its stack signal is ended at the stack limit", async () => {
  const source = `process.on("SIGQUIT", () => console.log("ignored")); ${sleeping(60000)}`;
  const { results } = await run([node("ignores", source, { timeoutMs: 500, stackSignal: "SIGQUIT" })], { concurrency: 1 });
  const result = results.get("ignores");
  assert.equal(result.status, "timeout", result.detail);
  assert.match(result.detail, /^exceeded 0\.500s and was sent SIGQUIT for its stacks; it did not exit within 10\.000s and was killed$/, result.detail);
  assert.match(result.output, /^ignored$/m, result.output);
});

test("a test over its limit is stopped before the process table is read, and its elapsed time is taken at the stop", async () => {
  // The runner reads the process table with `ps` at the limit. This `ps` takes 5 seconds, as a read under load can, so a runner that
  // reads the table before it stops the group runs the test for about 7 seconds in all.
  const directory = mkdtempSync(join(tmpdir(), "soksak-runner-ps-"));
  const ps = join(directory, "ps");
  writeFileSync(ps, "#!/bin/sh\nsleep 5\nexec /bin/ps \"$@\"\n");
  chmodSync(ps, 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${directory}:${saved}`;
  try {
    const { results } = await run([node("slow", sleeping(60000), { timeoutMs: 2000 })], { concurrency: 1 });
    const result = results.get("slow");
    assert.equal(result.status, "timeout", result.detail);
    assert.ok(result.elapsedMs < 6000, `the test ran ${result.elapsedMs} ms against its limit of 2000 ms while the process table was read`);
  } finally {
    process.env.PATH = saved;
    rmSync(directory, { recursive: true, force: true });
  }
});

// A group signal that the system refuses with EPERM, as macOS does for a group whose members have ended and remain as zombies.
const refusedWithEperm = () => { const error = new Error("kill EPERM"); error.code = "EPERM"; throw error; };

test("a refused group signal with no running member ends without error", () => {
  // The leader has ended and no process of its group remains, so the group has no running member.
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  assert.doesNotThrow(() => stopGroup(pid, refusedWithEperm));
  assert.doesNotThrow(() => killGroup(pid, refusedWithEperm));
});

test("a refused group signal with a running member names it", async () => {
  const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  try {
    assert.throws(() => stopGroup(live.pid, refusedWithEperm), (error) => error.code === "EPERM" && new RegExp(`pid ${live.pid} `).test(error.message), "the refused signal does not name the running member");
  } finally {
    process.kill(-live.pid, "SIGKILL");
  }
});

test("a refused group signal whose only member is exiting ends without error", () => {
  // The process table lists one member of the group in state ?NE, a process that is trying to exit (ps(1) flag E). The group signal is refused with EPERM.
  const pgid = 424242;
  const originalExecFileSync = childProcess.execFileSync;
  childProcess.execFileSync = (file, args, options) => (file === "ps" ? `${pgid + 1} ${pgid} ?NE\n` : originalExecFileSync(file, args, options));
  try {
    assert.doesNotThrow(() => stopGroup(pgid, refusedWithEperm));
    assert.doesNotThrow(() => killGroup(pgid, refusedWithEperm));
  } finally {
    childProcess.execFileSync = originalExecFileSync;
  }
});

test("a test file whose tests each pass within their own limits is not ended by the runner, though the tests together take longer", async () => {
  // Each test takes 600 ms under its own limit of 5000 ms, so the file takes about 1.2 s in total. The item declares no limit of its own.
  const directory = mkdtempSync(join(tmpdir(), "runner-file-"));
  try {
    const file = join(directory, "pair.test.mjs");
    const body = "() => new Promise((resolve) => setTimeout(resolve, 600))";
    writeFileSync(file, `import test from "node:test";\ntest("first", { timeout: 5000 }, ${body});\ntest("second", { timeout: 5000 }, ${body});\n`);
    const { results } = await run([{ name: "pair", command: process.execPath, args: ["--test", file] }], { concurrency: 1 });
    const result = results.get("pair");
    assert.equal(result.status, "pass", result.detail);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The reporter that writes each test event of a node --test file to the runner (scripts/test-event-reporter.mjs).
const EVENT_REPORTER = fileURLToPath(new URL("../test-event-reporter.mjs", import.meta.url));
// The file runs without NODE_TEST_CONTEXT, which would make node --test skip it (the same variable as nodeTestFile).
const eventsOf = (file, extra = {}) => ({ name: "events", command: "/usr/bin/env",
  args: ["-u", "NODE_TEST_CONTEXT", process.execPath, "--test", `--test-reporter=${EVENT_REPORTER}`, "--test-reporter-destination=stderr", file], ...extra });
// The flags of a process whose start takes 500 ms before its first event, as the start of a process takes on a loaded machine. The
// module blocks the main thread of the process before its script runs, so a test that judges the watchdog by the wall clock counts the
// start against the event limit.
function slowStart(folder) {
  const module = join(folder, "slow-start.mjs");
  writeFileSync(module, "const end = Date.now() + 500;\nwhile (Date.now() < end) {}\n");
  return ["--import", module];
}
// The statement that writes a test event line as the reporter does. The line is written with writeSync, because a write to a pipe on
// macOS is asynchronous and a process that blocks after it would keep the line.
const eventLine = (type, name) => `require("node:fs").writeSync(2, ${JSON.stringify(`${EVENT_PREFIX}${JSON.stringify({ type, name })}\n`)});`;
// Resolves when the output file of a test in the folder of the run holds `text`. The runner handles the event of a line before it
// appends the line to the output file, so a change of the folder is the event source of a handled event.
function untilOutput(path, text) {
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        if (readFileSync(path, "utf8").includes(text)) { watcher.close(); resolve(); }
      } catch (error) {
        if (error.code !== "ENOENT") { watcher.close(); reject(error); }
      }
    };
    const watcher = watch(dirname(path), check);
    check();
  });
}

// The event watchdog tests drive the timers of the runner with the mock clock and move it only after the runner handled an event of the
// process, so the time that the process takes to start or to write an event under load is not part of the result.
test("a test file whose test events stop for the event limit is ended at that limit, and the failure names the last event", async (t) => {
  // The process writes one event and then blocks its main thread for 30 s, as a test that blocks the event loop does.
  const folder = mkdtempSync(join(tmpdir(), "runner-events-"));
  const source = `${eventLine("test:pass", "quick first")} Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);`;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const outcome = run([{ name: "events", command: process.execPath, args: [...slowStart(folder), "-e", source], eventLimitMs: 300 }],
      { concurrency: 1, run: { id: "stop", folder: join(folder, "run") } });
    await untilOutput(join(folder, "run", "001-events.log"), '"name":"quick first"');
    t.mock.timers.tick(300);
    const result = (await outcome).results.get("events");
    assert.equal(result.status, "timeout", result.output);
    assert.equal(result.detail, "no test event for 300 ms, the largest limit of a test; last event: test:pass quick first");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a test file that does not exit after its tests ended fails at the exit limit with a sample of its processes", { timeout: 60000 }, async (t) => {
  // The test passes, and the exit listener then blocks the main thread for 30 s, as a process that waits in its shutdown does. The clock
  // moves by the exit limit after the summary, which stays below the event limit, so a runner without the exit limit does not end it.
  const { file, folder } = await nodeTestFile([
    'import test from "node:test";',
    'test("passes", () => {});',
    'process.on("exit", () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); });',
  ].join("\n") + "\n");
  const runFolder = join(folder, "run");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const outcome = run([eventsOf(file, { eventLimitMs: 20000, exitLimitMs: 1000 })], { concurrency: 1, run: { id: "exit", folder: runFolder } });
    await untilOutput(join(runFolder, "001-events.log"), '"type":"test:summary"');
    t.mock.timers.tick(1000);
    const result = (await outcome).results.get("events");
    assert.equal(result.status, "fail", `${result.status}: ${result.detail}`);
    const match = /^the file process did not exit within 1\.000s after its tests ended; last event: test:summary; samples: ([^;]+)(?:; left running: .+)?$/.exec(result.detail);
    assert.ok(match, result.detail);
    for (const path of match[1].split(", ")) {
      assert.ok(path.startsWith(`${runFolder}/`), `${path} is not in the folder of the run`);
      assert.match(readFileSync(path, "utf8"), /Call graph:/, `${path} holds no thread stacks`);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a test file whose test events keep arriving is not ended at the event limit, though it runs longer than the limit", async (t) => {
  // The process writes the event of step n after the file go-<n - 1> appears, and exits after step 5. The clock moves by 299 ms after
  // each event, 1495 ms in all, so the events of the process do not stop for the limit of 300 ms.
  const folder = mkdtempSync(join(tmpdir(), "runner-events-"));
  const source = [
    'const { existsSync, watch, writeSync } = require("node:fs");',
    `const folder = ${JSON.stringify(folder)};`,
    'let step = 0;',
    'const next = () => {',
    '  step += 1;',
    '  if (step > 5) { watcher.close(); return; }',
    `  writeSync(2, ${JSON.stringify(EVENT_PREFIX)} + JSON.stringify({ type: "test:pass", name: "step " + step }) + "\\n");`,
    '};',
    'const watcher = watch(folder, () => { if (existsSync(`${folder}/go-${step}`)) next(); });',
    'next();',
  ].join("\n");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const outcome = run([{ name: "events", command: process.execPath, args: [...slowStart(folder), "-e", source], eventLimitMs: 300 }],
      { concurrency: 1, run: { id: "arrive", folder: join(folder, "run") } });
    for (let step = 1; step <= 5; step++) {
      await untilOutput(join(folder, "run", "001-events.log"), `"name":"step ${step}"`);
      t.mock.timers.tick(299);
      writeFileSync(join(folder, `go-${step}`), "");
    }
    const result = (await outcome).results.get("events");
    assert.equal(result.status, "pass", result.detail);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// A test process that ends while a test runs: node --test reports the results of the earlier tests and no result, error or
// cancellation for the running test, so its summary counts fewer tests than started. The ending is the system signal of the
// file process, as a crash of a native module of a check (SIGSEGV) ends it.
const endsMidTest = (ending) => [
  'import test from "node:test";',
  'test("passes first", () => {});',
  `test("ends the process", async () => { await new Promise((resolve) => setTimeout(resolve, 20)); ${ending}; await new Promise((resolve) => setTimeout(resolve, 2000)); });`,
  'test("queued after", () => {});',
].join("\n") + "\n";

test("a test file whose process is killed while a test runs fails with the test that has no result and the signal", async () => {
  const { file, folder } = await nodeTestFile(endsMidTest('process.kill(process.pid, "SIGKILL")'));
  try {
    const { results } = await run([eventsOf(file, { eventLimitMs: 60_000 })], { concurrency: 1 });
    const result = results.get("events");
    assert.equal(result.status, "fail", result.output);
    assert.equal(result.detail, "the test process ended by signal SIGKILL while a test ran; started without a result: ends the process; queued without a start: queued after");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a test file whose process exits with status 0 while a test runs fails with the test that has no result", async () => {
  const { file, folder } = await nodeTestFile(endsMidTest("process.exit(0)"));
  try {
    const { results } = await run([eventsOf(file, { eventLimitMs: 60_000 })], { concurrency: 1 });
    const result = results.get("events");
    assert.equal(result.status, "fail", result.output);
    assert.equal(result.detail, "the test process ended by exit 0 while a test ran; started without a result: ends the process; queued without a start: queued after");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a test file of suites, subtests, skipped, todo and filtered tests that ends by itself has a result for every started test", async () => {
  const { file, folder } = await nodeTestFile([
    'import { describe, it, test } from "node:test";',
    'describe("suite", () => { it("inner", () => {}); it.skip("skipped inner", () => {}); });',
    'test("parent", async (t) => { await t.test("child", () => {}); await t.test("child", () => {}); });',
    'test.todo("todo", () => {});',
    'test("filtered out", () => { throw new Error("runs only without the name pattern"); });',
    'test("times out", { timeout: 50 }, () => new Promise((resolve) => setTimeout(resolve, 1000)));',
  ].join("\n") + "\n");
  try {
    const item = eventsOf(file, { eventLimitMs: 60_000 });
    item.args.splice(item.args.indexOf("--test") + 1, 0, "--test-name-pattern=^(?!filtered)");
    const { results } = await run([item], { concurrency: 1 });
    const result = results.get("events");
    // The test over its own limit fails the file through the status of node --test, and no started test lacks a result.
    assert.equal(result.status, "fail", result.output);
    assert.equal(result.detail, "exit 1", result.output);
    assert.ok(!result.output.includes("runs only without the name pattern"), result.output);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
