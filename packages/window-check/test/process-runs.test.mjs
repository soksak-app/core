import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { processRuns } from "../process-group.mjs";

const ZOMBIE_HOLDER = fileURLToPath(new URL("../fixtures/zombie-holder.pl", import.meta.url));

/** Resolves with the process id of the zombie that the holder keeps; the holder ends with the test. */
async function zombie(t) {
  const holder = spawn("perl", [ZOMBIE_HOLDER], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => holder.kill("SIGKILL"));
  let text = "";
  holder.stdout.setEncoding("utf8");
  for await (const chunk of holder.stdout) {
    text += chunk;
    if (text.includes("\n")) break;
  }
  const pid = Number(text.trim());
  assert.ok(Number.isInteger(pid) && pid > 0, `the zombie holder printed no process id: ${JSON.stringify(text)}`);
  return pid;
}

test("a process that has ended and waits to be reaped does not run, although the system accepts signal 0 for it", { timeout: 20000 }, async (t) => {
  const pid = await zombie(t);
  // kill(pid, 0) answers success for a zombie, which made the fixture registry test read an ended pack as alive (F819).
  assert.doesNotThrow(() => process.kill(pid, 0));
  assert.equal(processRuns(pid), false);
});

test("a running process runs and an absent process does not", { timeout: 20000 }, async (t) => {
  const holder = spawn("perl", ["-e", "sleep 60"], { stdio: "ignore" });
  t.after(() => holder.kill("SIGKILL"));
  await once(holder, "spawn");
  assert.equal(processRuns(holder.pid), true);
  holder.kill("SIGKILL");
  await once(holder, "exit");
  assert.equal(processRuns(holder.pid), false);
});
