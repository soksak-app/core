// Reads the process table of macOS through the system libproc and sysctl, so no check starts a process tool to read it
// (docs/spec/verification.md#process-table). Node has no process table interface, so koffi calls the C functions of libSystem:
// sysctl(3) with KERN_PROC_ALL for the table, as ps reads it, and with KERN_PROCARGS2 for the arguments of a process,
// proc_pidinfo and proc_pidpath of libproc.h for the task, the working directory and the executable of a process, and mach_timebase_info for the unit of the CPU
// times. The structure offsets are those of sys/sysctl.h, sys/proc.h and sys/proc_info.h of the macOS SDK.
import koffi from "koffi";

const system = koffi.load("/usr/lib/libSystem.B.dylib");
const proc_pidpath = system.func("int proc_pidpath(int pid, _Out_ uint8_t *buffer, uint32_t size)");
const proc_pidinfo = system.func("int proc_pidinfo(int pid, int flavor, uint64_t arg, _Out_ uint8_t *buffer, int size)");
const sysctl = system.func("int sysctl(int32_t *name, uint32_t length, _Out_ uint8_t *old, _Inout_ size_t *oldLength, void *new, size_t newLength)");
const mach_timebase_info = system.func("int mach_timebase_info(_Out_ uint32_t *info)");

// sys/sysctl.h and sys/proc.h: struct kinfo_proc and the offsets of the read fields.
const KINFO_SIZE = 648;
const KINFO = { flag: 32, stat: 36, pid: 40, comm: 243, ppid: 560, pgid: 564 };
const P_WEXIT = 0x2000;
const SZOMB = 5;
// sys/proc_info.h: the flavors, the sizes of their structures and the offsets of the read fields.
const PROC_PIDTASKINFO = 4;
const TASKINFO_SIZE = 96;
const TASK = { resident: 8, user: 16, system: 24 };
const PROC_PIDVNODEPATHINFO = 9;
const VNODEPATHINFO_SIZE = 2352;
const CDIR_PATH = 152;
const PATH_SIZE = 1024;
// sys/sysctl.h.
const CTL_KERN = 1;
const KERN_PROC = 14;
const KERN_PROC_ALL = 0;
const KERN_ARGMAX = 8;
const KERN_PROCARGS2 = 49;

const EPERM = 1;
const ESRCH = 3;
const ENOMEM = 12;

let timebase;
/** The nanoseconds of one unit of the CPU times of proc_taskinfo, which count Mach absolute time. */
function nanosecondsPerTick() {
  if (timebase === undefined) {
    const info = new Uint32Array(2);
    const code = mach_timebase_info(info);
    if (code !== 0) throw new Error(`mach_timebase_info returned ${code}`);
    timebase = info[0] / info[1];
  }
  return timebase;
}

const text = (bytes, start, length) => {
  const end = bytes.indexOf(0, start);
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, (end < 0 || end > start + length ? start + length : end) - start).toString("utf8");
};

/** The kinfo_proc records of every process of the system. */
function allProcesses() {
  const name = new Int32Array([CTL_KERN, KERN_PROC, KERN_PROC_ALL]);
  for (;;) {
    const length = [0];
    if (sysctl(name, 3, null, length, null, 0) !== 0) throw new Error(`sysctl KERN_PROC_ALL failed (errno ${koffi.errno()})`);
    // The table can grow between the two calls, so the buffer holds more than the first answer.
    length[0] += 64 * KINFO_SIZE;
    const buffer = new Uint8Array(length[0]);
    if (sysctl(name, 3, buffer, length, null, 0) === 0) return { buffer, count: length[0] / KINFO_SIZE };
    if (koffi.errno() !== ENOMEM) throw new Error(`sysctl KERN_PROC_ALL failed (errno ${koffi.errno()})`);
  }
}

/**
 * The proc_pidinfo structure of flavor for pid, or null for a process that ended since the table was read or that the system does
 * not describe to this user (EPERM).
 */
function pidinfo(pid, flavor, size) {
  const buffer = new Uint8Array(size);
  const written = proc_pidinfo(pid, flavor, 0, buffer, size);
  if (written === size) return buffer;
  const errno = koffi.errno();
  if (written <= 0 && (errno === ESRCH || errno === EPERM)) return null;
  throw new Error(`proc_pidinfo(${pid}, ${flavor}) wrote ${written} of ${size} bytes (errno ${errno})`);
}

let argmax;
// libproc.h: PROC_PIDPATHINFO_MAXSIZE.
const PATH_MAXSIZE = 4096;

/** The path of the executable of pid, or null when the process ended or has no executable path. */
function executableOf(pid) {
  const buffer = new Uint8Array(PATH_MAXSIZE);
  const length = proc_pidpath(pid, buffer, PATH_MAXSIZE);
  return length > 0 ? Buffer.from(buffer.subarray(0, length)).toString("utf8") : null;
}

/**
 * The arguments of pid joined by spaces, as ps prints its command. A zombie, a process of another user and a system process give no
 * arguments; their command is their name in parentheses, as ps prints it.
 */
function commandOf(pid, name) {
  if (argmax === undefined) {
    const value = new Uint8Array(4);
    const length = [4];
    if (sysctl(new Int32Array([CTL_KERN, KERN_ARGMAX]), 2, value, length, null, 0) !== 0) {
      throw new Error(`sysctl KERN_ARGMAX failed (errno ${koffi.errno()})`);
    }
    argmax = new DataView(value.buffer).getInt32(0, true);
  }
  const buffer = new Uint8Array(argmax);
  const length = [argmax];
  if (sysctl(new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]), 3, buffer, length, null, 0) !== 0) return `(${name})`;
  const view = new DataView(buffer.buffer);
  const argc = view.getInt32(0, true);
  let offset = 4;
  // The executable path, then the padding of NUL bytes before the arguments.
  offset = buffer.indexOf(0, offset);
  while (offset < length[0] && buffer[offset] === 0) offset += 1;
  const args = [];
  for (let index = 0; index < argc && offset < length[0]; index += 1) {
    const end = buffer.indexOf(0, offset);
    args.push(Buffer.from(buffer.subarray(offset, end < 0 ? length[0] : end)).toString("utf8"));
    offset = end < 0 ? length[0] : end + 1;
  }
  return args.join(" ");
}

/**
 * The processes of the system: `{pid, ppid, pgid, state, name}` with `state` `running`, `exiting` or `zombie`, and with `command`
 * (the arguments joined by spaces), `executable` (the path that the process executes, or null), `residentKb` and `cpuSeconds` when
 * `fields` names them. A size that the system does not give to
 * this user, or of a process that ended while the table was read, is absent from its row.
 */
export function processes(fields = {}) {
  const { buffer, count } = allProcesses();
  const view = new DataView(buffer.buffer);
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const base = index * KINFO_SIZE;
    const pid = view.getInt32(base + KINFO.pid, true);
    if (pid === 0) continue;
    const stat = buffer[base + KINFO.stat];
    const flag = view.getInt32(base + KINFO.flag, true);
    const row = {
      pid,
      ppid: view.getInt32(base + KINFO.ppid, true),
      pgid: view.getInt32(base + KINFO.pgid, true),
      state: stat === SZOMB ? "zombie" : (flag & P_WEXIT) !== 0 ? "exiting" : "running",
      name: text(buffer, base + KINFO.comm, 17),
    };
    if (fields.command) row.command = row.state === "zombie" ? `(${row.name})` : commandOf(pid, row.name);
    if (fields.executable) row.executable = row.state === "zombie" ? null : executableOf(pid);
    if ((fields.residentKb || fields.cpuSeconds) && row.state !== "zombie") {
      const task = pidinfo(pid, PROC_PIDTASKINFO, TASKINFO_SIZE);
      if (task !== null) {
        const tasks = new DataView(task.buffer);
        if (fields.residentKb) row.residentKb = Number(tasks.getBigUint64(TASK.resident, true) / 1024n);
        if (fields.cpuSeconds) {
          const ticks = tasks.getBigUint64(TASK.user, true) + tasks.getBigUint64(TASK.system, true);
          row.cpuSeconds = Number(ticks) * nanosecondsPerTick() / 1e9;
        }
      }
    }
    rows.push(row);
  }
  return rows;
}

/** The working directory of pid, or null when the process ended. */
export function workingDirectory(pid) {
  const info = pidinfo(pid, PROC_PIDVNODEPATHINFO, VNODEPATHINFO_SIZE);
  return info === null ? null : text(info, CDIR_PATH, PATH_SIZE);
}
