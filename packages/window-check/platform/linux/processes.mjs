// Reads the process table of Linux from procfs (proc(5)), so no check starts a process tool to read it
// (docs/spec/verification.md#process-table).
import { readFileSync, readdirSync, readlinkSync } from "node:fs";

// The clock ticks of the CPU times of /proc/<pid>/stat. USER_HZ is 100 on every architecture that Linux supports for user space.
const USER_HZ = 100;

/** The contents of a file of /proc/<pid>, or null when the process ended or the file is not readable by this user. */
function read(path, reader = readFileSync) {
  try {
    return reader(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH" || error.code === "EACCES") return null;
    throw error;
  }
}

/** The fields of /proc/<pid>/stat after the name, which is in parentheses and may hold spaces and parentheses. */
function statFields(stat) {
  const close = stat.lastIndexOf(")");
  return { name: stat.slice(stat.indexOf("(") + 1, close), fields: stat.slice(close + 2).split(" ") };
}

/**
 * The processes of the system: `{pid, ppid, pgid, state, name}` with `state` `running`, `exiting` (X, dead) or `zombie` (Z), and with
 * `command` (the arguments joined by spaces), `executable` (the path that the process executes, or null), `residentKb` and
 * `cpuSeconds` when `fields` names them. A process that ends while the table is read is left out.
 */
export function processes(fields = {}) {
  const rows = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = read(`/proc/${entry}/stat`);
    if (stat === null) continue;
    const { name, fields: parts } = statFields(stat);
    // proc(5): state, ppid, pgrp, ..., utime (14), stime (15) counted from the state as field 3.
    const row = {
      pid: Number(entry),
      ppid: Number(parts[1]),
      pgid: Number(parts[2]),
      state: parts[0] === "Z" ? "zombie" : parts[0] === "X" ? "exiting" : "running",
      name,
    };
    if (fields.command) {
      const line = read(`/proc/${entry}/cmdline`);
      if (line === null) continue;
      row.command = line === "" ? `[${name}]` : line.replace(/\0$/, "").split("\0").join(" ");
    }
    if (fields.executable) row.executable = read(`/proc/${entry}/exe`, (path) => readlinkSync(path));
    if (fields.residentKb) {
      const status = read(`/proc/${entry}/status`);
      const resident = status === null ? null : /^VmRSS:\s+(\d+) kB$/m.exec(status);
      if (resident !== null) row.residentKb = Number(resident[1]);
    }
    if (fields.cpuSeconds) row.cpuSeconds = (Number(parts[11]) + Number(parts[12])) / USER_HZ;
    rows.push(row);
  }
  return rows;
}

/** The working directory of pid, or null when the process ended. */
export function workingDirectory(pid) {
  return read(`/proc/${pid}/cwd`, (path) => readlinkSync(path));
}
