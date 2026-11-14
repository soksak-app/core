// Signals the process group of a test or of a command and reads its members from the process table, by one rule for every caller:
// the command supervisor (scripts/test-command.mjs), the test runner (scripts/test-runner.mjs) and the commands of the harness
// (test-app.mjs).
import childProcess from "node:child_process";

// kill(-pgid, sig) of macOS returns EPERM when the group has no member that can receive the signal. A member that has ended but whose parent has not yet reaped it
// (a zombie) stays in the group until it is reaped, and a group that holds only zombies also receives this answer. So a rejected check
// reads the members of the group and their states from the process table and judges from them.
export function groupMembers(pgid) {
  const table = childProcess.execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" });
  const members = [];
  for (const line of table.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.trim().split(/\s+/);
    const memberPid = Number(fields[0]);
    const memberGroup = Number(fields[1]);
    if (fields.length !== 3 || !Number.isInteger(memberPid) || !Number.isInteger(memberGroup)) throw new Error(`ps returned an unreadable process line: ${JSON.stringify(line)}`);
    if (memberGroup === pgid) members.push({ pid: memberPid, state: fields[2] });
  }
  return members;
}

/** The processes of the system as pid, parent, group and state. Only numbers and states are read, so the output stays small. */
export function processTable() {
  const table = childProcess.execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return table.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const fields = line.trim().split(/\s+/);
    const row = { pid: Number(fields[0]), ppid: Number(fields[1]), pgid: Number(fields[2]), state: fields[3] };
    if (fields.length !== 4 || !Number.isInteger(row.pid) || !Number.isInteger(row.ppid) || !Number.isInteger(row.pgid)) {
      throw new Error(`ps returned an unreadable process line: ${JSON.stringify(line)}`);
    }
    return row;
  });
}

// ps(1) state: the first character is the run state, and the characters after it are flags. Z is a zombie, which has ended and waits to be
// reaped. The flag E marks a process that is trying to exit, which has also ended its work.
export function hasEnded(state) {
  return state.startsWith("Z") || state.slice(1).includes("E");
}

/** The members that can still run: a zombie or an exiting process has ended its work. */
export function runningMembers(pgid, members = groupMembers(pgid)) {
  return members.filter((member) => !hasEnded(member.state));
}

/**
 * Whether the process pid still runs, by the rule of the group: a process that is absent from the process table, a zombie or exiting has
 * ended. Signal 0 to the pid does not decide it, because the system answers it with success for a zombie that waits to be reaped.
 */
export function processRuns(pid, table = processTable) {
  const row = table().find((entry) => entry.pid === pid);
  return row !== undefined && !hasEnded(row.state);
}

/** Sends a signal to the process group pgid. The default is the group signal of the system; a test passes its own sender. */
const sendToGroup = (pgid, signal) => process.kill(-pgid, signal);

export const named = (members) => members.map((member) => `pid ${member.pid} ${member.state}`).join("; ");

/**
 * Sends a signal to the group pgid. macOS refuses a group signal with EPERM when no member of the group can receive it, which is the case
 * when only zombies remain; such a group has nothing to end, so the refusal is not an error. A refusal while a member runs is an error,
 * and the error names the running members. Every other refusal is an error that names the signal and the group.
 */
export function signalGroup(pgid, signal, send = sendToGroup, members = groupMembers) {
  try { send(pgid, signal); } catch (error) {
    if (error.code === "ESRCH") return;
    error.message = `${signal} to process group ${pgid}: ${error.message}`;
    if (error.code !== "EPERM") throw error;
    const running = runningMembers(pgid, members(pgid));
    if (running.length === 0) return;
    error.message += `; running: ${named(running)}`;
    throw error;
  }
}

/**
 * Whether a member of the group pgid still runs. The probe is signal 0, and its refusal is judged by the rule of signalGroup: a group
 * that no longer exists or that holds only ended members runs nothing.
 */
export function groupRuns(pgid, send = sendToGroup) {
  try {
    send(pgid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code !== "EPERM") throw error;
    return runningMembers(pgid).length > 0;
  }
}

/**
 * Stops every process of the group of a test with SIGSTOP, so none of them runs while the leftovers are read. The stop comes before the
 * read, because the read takes seconds under load. A group that no longer exists has nothing to stop.
 */
export function stopGroup(pgid, send = sendToGroup, members = groupMembers) {
  signalGroup(pgid, "SIGSTOP", send, members);
}

/** Ends every process of the group pgid, the group of a test or of a bounded command. A group that no longer exists has nothing to end. */
export function killGroup(pgid, send = sendToGroup, members = groupMembers) {
  signalGroup(pgid, "SIGKILL", send, members);
}
