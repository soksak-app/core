// A stall sample that a request starts after STALL_AFTER belongs to its session: the session finish waits for it and
// reports its result or its failure, so no sample process outlives the check (F292-47).
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

delete process.env.SOKSAK_RUN_ID;
delete process.env.SOKSAK_RUN_FOLDER;

// The sample processes that the session started and not yet ended, as their execFile callbacks.
const running = [];
mock.module("node:child_process", {
  namedExports: {
    ...childProcess,
    execFile(command, args, options, callback) {
      if (command === "/bin/launchctl") {
        queueMicrotask(() => callback(null, "pid/20 = {\n\tservices = {\n\t\t      21      - \tcom.apple.WebKit.WebContent.A\n\t}\n}\n", ""));
        return;
      }
      if (command !== "/usr/bin/sandbox-exec" || args[2] !== "/usr/bin/sample") throw new Error(`unexpected execFile: ${command}`);
      running.push({ pid: Number(args[3]), file: args[args.indexOf("-file") + 1], callback });
    },
  },
});
mock.module("../event-log.mjs", {
  namedExports: { readEventErrors: () => ({ errors: [] }), sessionEventBoot: () => 0, sessionEventStart: () => ({}) },
});
const { finishSession, Session } = await import("../app.mjs");

// The top-of-stack section of a report of /usr/bin/sample whose threads wait in the run loop of the process.
const SAMPLE_REPORT = "Sort by top of stack, same collapsed (when >= 5):\n        mach_msg2_trap  (in libsystem_kernel.dylib)        876\n        __workq_kernreturn  (in libsystem_kernel.dylib)        876\n";

const settle = async () => { for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve)); };

// A session whose request answers when the check calls answer, after the stall timer has started the samples.
function stalledSession(t) {
  const configDir = mkdtempSync(join(tmpdir(), "soksak-stall-session-"));
  // The host of a running application holds the logs folder of its configuration, where the samples write their reports.
  mkdirSync(join(configDir, "logs"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  let answer;
  const client = {
    endpoint: { pid: 20 },
    request(method) {
      if (method === "diagnostics.stall.dump") return Promise.resolve({ boot: "b1", seq: 4, running: "wait_presented 3.0s" });
      return new Promise((resolve) => { answer = resolve; });
    },
  };
  const session = new Session({ name: "probe", configDir }, client);
  return { session, answer: (value) => answer(value) };
}

function probe() {
  const diagnostics = [];
  return { diagnostics, check: { name: "probe check", passed: true, diagnostic: (line) => diagnostics.push(line) } };
}

test("the session finish waits for a stall sample that a request answered after STALL_AFTER started", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  running.length = 0;
  const { session, answer } = stalledSession(t);
  const reply = session.request("host.window.reload");
  t.mock.timers.tick(3000);
  await settle();
  assert.deepEqual(running.map(({ pid }) => pid), [20, 21], "the stall timer started the host and page samples");
  answer({ done: true });
  assert.deepEqual(await reply, { done: true });
  const { diagnostics, check } = probe();
  let finished = false;
  const finish = finishSession(check, session, () => {}).then(() => { finished = true; });
  await settle();
  assert.equal(finished, false, "the session finished while its stall sample processes still ran");
  // A sample that ends writes its report file in the form of /usr/bin/sample; its threads wait in no flock here.
  for (const { file, callback } of running) {
    assert.ok(existsSync(dirname(file)), `the folder of the sample report ${file} does not exist`);
    writeFileSync(file, SAMPLE_REPORT);
    callback(null, "", "");
  }
  await finish;
  const logs = join(session.app.configDir, "logs").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  assert.deepEqual(diagnostics.filter((line) => line.startsWith("stall sample")).map((line) => new RegExp(
    `^stall sample: probe host\\.window\\.reload still pending after 3000 ms; the host's threads at that moment: ` +
    `${logs}/stall-20-\\d+\\.txt, ${logs}/stall-20-\\d+-page-21\\.txt; host\\.stall\\.dump at b1:4; running host calls of main: wait_presented 3\\.0s$`).test(line)), [true]);
});

// A stall sample is a record of the check, as a recording is: a sample that a loaded machine or the sample tool cannot finish
// is reported with its reason, and the result of the check stays the result of what it checked (F775).
test("the session finish reports a stall sample that failed and does not fail the check for it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  running.length = 0;
  const { session, answer } = stalledSession(t);
  const reply = session.request("host.window.reload");
  t.mock.timers.tick(3000);
  await settle();
  answer({ done: true });
  await reply;
  const { diagnostics, check } = probe();
  const finish = finishSession(check, session, () => {});
  const error = Object.assign(new Error("Command failed"), { code: 1 });
  for (const { callback } of running) callback(error, "", "sample cannot examine process\n");
  await finish;
  assert.deepEqual(diagnostics.filter((line) => line.startsWith("stall sample") || line.startsWith("cleanup failed")),
    ["stall sample: probe host.window.reload still pending after 3000 ms; sampling the host failed: the host 20 and its pages were not sampled: sample 20 exited with 1: sample cannot examine process; sample 21 exited with 1: sample cannot examine process"]);
});
