import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import { groupMembers, killGroup, runningMembers, terminateGroup } from "../process-group.mjs";

// The member ignores SIGTERM and prints its pid after it installed the handler, so the pid is read only when SIGTERM cannot end it. It
// runs while it reads its input, which the leader holds open.
const MEMBER_SOURCE = "process.on('SIGTERM', () => {}); console.log(process.pid); process.stdin.resume();";
// The leader ignores SIGTERM and starts the member, which inherits the group of the leader and the stdout of the leader. The leader runs
// while its member runs, because it holds the input pipe of the member.
const LEADER_SOURCE = `process.on('SIGTERM', () => {}); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(MEMBER_SOURCE)}], { stdio: ['pipe', 'inherit', 'ignore'] });`;

test("does not count a member that is exiting as running", () => {
  // The kernel marks a process that is trying to exit (P_WEXIT). The measured exiting member of F292-58 counted as running under a
  // zombie-only check and failed a passing test.
  assert.deepEqual(runningMembers(10, [{ pid: 11, state: "exiting" }, { pid: 13, state: "zombie" }]), []);
  assert.deepEqual(runningMembers(10, [{ pid: 14, state: "running" }, { pid: 15, state: "exiting" }]), [{ pid: 14, state: "running" }]);
});

test("does not report a member that already received SIGKILL again at the exit of the leader", { timeout: 20000 }, async (t) => {
  const leader = spawn(process.execPath, ["-e", LEADER_SOURCE], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
  const pgid = leader.pid;
  t.after(() => killGroup(pgid));
  leader.stdout.setEncoding("utf8");
  let text = "";
  for await (const chunk of leader.stdout) {
    text += chunk;
    if (text.includes("\n")) break;
  }
  const memberPid = Number(text.trim());
  assert.ok(Number.isInteger(memberPid) && memberPid > 0, `the member printed no process id: ${JSON.stringify(text)}`);
  const exited = once(leader, "exit");
  // Injected fault: after the first SIGKILL the group answers its probe as running and lists the member as running, which is the state
  // that a member shows while the kernel ends it. The order is fixed by the code: `afterKill` turns on before the exit event of the leader
  // is delivered, because that event is delivered by the event loop after this function returns.
  let afterKill = false;
  const send = (group, signal) => {
    if (signal === 0 && afterKill) return;
    process.kill(-group, signal);
  };
  const members = (group) => {
    const rows = groupMembers(group).filter((member) => member.pid !== memberPid || !afterKill);
    if (afterKill) rows.push({ pid: memberPid, state: "running" });
    return rows;
  };
  const records = [];
  const { ended, kill } = terminateGroup(pgid, { exited, report: (record) => records.push(record) }, send, members);
  kill("second-cancellation");
  afterKill = true;
  await ended;
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL");
  assert.deepEqual(records.map((record) => record.reason), ["second-cancellation"], JSON.stringify(records));
  assert.ok(records[0].running.some((member) => member.pid === memberPid), JSON.stringify(records));
});
