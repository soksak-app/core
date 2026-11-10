// Keeps the thread stacks of a host that does not answer, at that moment. What the main thread did while a request did
// not answer within the limit can be seen only then, so the check records every thread of the host process at that
// moment with sample of macOS. A process of the same user can be sampled without privilege.
import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";
import { joinedFailure } from "./failure.mjs";

/** The seconds in which sample watches the host. One short record shows the stack of the blocked main thread. */
const SECONDS = 2;

/** The milliseconds of the record of a sample that stalled. Its record takes one second and about one more to write. */
const SAMPLER_LIMIT = 5000;

/** The milliseconds in which a process at its limit waits for the state of that moment, longer than SAMPLER_LIMIT. */
const STATE_LIMIT = 6000;

// The state of the machine when a process reached its limit. A stalled process writes nothing itself, so what it waited
// for is seen only from what surrounds it at that moment.
async function systemState() {
  const { bavail, bsize } = await statfs("/");
  return `free ${Math.floor(bavail * bsize / 1048576)} MB on /, load ${loadavg()[0].toFixed(1)}`;
}

/**
 * The state of the machine and the stacks of the process pid of sample, recorded in file, while it stalls. It names
 * the reason when the stacks could not be recorded, because then the state is all that remains of that moment.
 *
 * run(command, args, options)  an executor that resolves to a process result ({status, stderr}). The checks replace it.
 */
export async function samplerState(pid, file, run = runProcess) {
  const [state, result] = await Promise.all([systemState(), run("/usr/bin/sample", [String(pid), "1", "-file", file], { limitMs: SAMPLER_LIMIT, atLimit: null })]);
  if (result.error) return `${state}, stacks of the process not recorded: ${result.error.message}`;
  if (result.status !== 0) return `${state}, stacks of the process not recorded: exited with ${result.status}: ${String(result.stderr).trim()}`;
  return `${state}, stacks of the process: ${file}`;
}

// The error of a process that did not reach its own exit. A signal is named with what is known of its sender, because
// the text of execFile names neither: `killed` is set when the limit ended the process.
function endError(error, stderr, limitMs, state) {
  if (!error.signal) return error;
  const limit = error.killed ? ` at its limit of ${limitMs} ms` : "";
  const at = error.killed && state !== undefined ? `; at the limit: ${state}` : "";
  return new Error(`ended by ${error.signal}${limit}; standard error: ${stderr.trim() || "none"}${at}`);
}

// The answer of atLimit within stateLimitMs. What it reads may wait for the same thing as the stalled process.
function readState(atLimit, pid, stateLimitMs) {
  return new Promise((resolve) => {
    AbortSignal.timeout(stateLimitMs).addEventListener("abort", () => resolve(`not read within ${stateLimitMs} ms`), { once: true });
    atLimit(pid).then(resolve, (error) => resolve(`not read: ${error.message}`));
  });
}

/**
 * Runs command with its own limit, so child operations never block endpoint reads or test deadlines. At the limit the
 * process still runs while atLimit(pid) reads the state of that moment, within stateLimitMs, and then ends. A null
 * atLimit ends it at once. The limit runs on AbortSignal.timeout: a check that moves mocked timers does not move it.
 */
export function runProcess(command, args, { limitMs = 10000, atLimit = systemState, stateLimitMs = STATE_LIMIT } = {}) {
  return new Promise((resolve) => {
    const limit = AbortSignal.timeout(limitMs);
    let state;
    const end = async () => {
      if (atLimit !== null) state = await readState(atLimit, child.pid, stateLimitMs);
      child.kill();
    };
    const child = execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      limit.removeEventListener("abort", end);
      resolve({ status: error?.code ?? 0, stdout, stderr,
        error: error && typeof error.code !== "number" ? endError(error, stderr, limitMs, state) : undefined });
    });
    limit.addEventListener("abort", end, { once: true });
  });
}

/**
 * The milliseconds that a request may stay pending before the check samples the host and its page processes. A pending
 * request has no event source: it is pending exactly while nothing comes back, so a timer per pending request is the only
 * source of the mark. A stall that ends before the request limit is recorded only when it starts at this mark.
 */
export const STALL_AFTER = 3000;

/**
 * Writes the thread stacks of process pid to file and returns file. It fails with the reason when sample fails, and a
 * sample that stalls leaves the stacks of its own process next to file.
 *
 * run(command, args, options)  an executor that resolves to a process result ({status, stderr}). The checks replace it.
 */
export async function sampleProcess(pid, file, run = runProcess) {
  const atLimit = (sampler) => samplerState(sampler, `${file}.sampler.txt`);
  const result = await run("/usr/bin/sample", [String(pid), String(SECONDS), "-file", file], { atLimit });
  if (result.error) throw new Error(`sample ${pid}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`sample ${pid} exited with ${result.status}: ${String(result.stderr).trim()}`);
  return file;
}

/**
 * The running services of the launchd domain of process host, as { pid, label }. launchd runs the WebKit services of an
 * application in the launchd domain of its process, and `launchctl print pid/<host>` lists each service of that domain as
 * a line `<pid> <status> <label>`, with pid 0 for a service that does not run; no other interface lists the services of
 * another process. It fails with the reason when launchctl fails.
 *
 * run(command, args)  an executor that resolves to a process result ({status, stdout, stderr}). The checks replace it.
 */
export async function launchdServices(host, run = runProcess) {
  const result = await run("/bin/launchctl", ["print", `pid/${host}`]);
  if (result.error) throw new Error(`launchctl print pid/${host}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`launchctl print pid/${host} exited with ${result.status}: ${String(result.stderr).trim()}`);
  return String(result.stdout).split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length === 3 && /^[1-9][0-9]*$/.test(fields[0]))
    .map((fields) => ({ pid: Number(fields[0]), label: fields[2] }));
}

/**
 * The running WebContent processes of host, which run its pages. While the page does not answer, its JavaScript runs in
 * this process and not in the host, so it is recorded too. They are the WebContent services of the launchd domain of host
 * (launchdServices). It fails with the reason when launchctl fails.
 *
 * run(command, args)  an executor that resolves to a process result ({status, stdout, stderr}). The checks replace it.
 */
export async function pageProcesses(host, run = runProcess) {
  return (await launchdServices(host, run))
    .filter(({ label }) => label.startsWith("com.apple.WebKit.WebContent."))
    .map(({ pid }) => pid);
}

/**
 * Whether a thread of the process that the text of sample describes waited in flock(2). A thread that waits there is at
 * the top of its stack in `flock` of libsystem_kernel, and sample lists the top of each stack in the section `Sort by top
 * of stack, same collapsed`, one frame in each line with its count, until an empty line. It fails when the text has no
 * such section, because then no answer can be read from it.
 */
export function waitsInFlock(text) {
  const lines = String(text).split("\n");
  const start = lines.findIndex((line) => line.startsWith("Sort by top of stack, same collapsed"));
  if (start === -1) throw new Error("the sample has no section \"Sort by top of stack, same collapsed\"");
  const end = lines.findIndex((line, index) => index > start && line.trim() === "");
  return lines.slice(start + 1, end === -1 ? lines.length : end)
    .some((line) => /^\s+flock\s+\(in libsystem_kernel\.dylib\)\s+\d+\s*$/.test(line));
}

/**
 * The open files of the field output of `lsof -F pcftn` (lsof(8), OUTPUT FOR OTHER PROGRAMS), as { pid, command, fd,
 * type, name }. Each line is one field: its first character names it (`p` process, `c` command, `f` descriptor, `t` type,
 * `n` name) and the rest is its value; a `p` line starts a process and an `f` line starts a file of that process. It
 * fails on a line of another field or a file before its process, because the output then is not what was asked for.
 */
export function lsofFiles(stdout) {
  const files = [];
  let owner = null;
  for (const line of String(stdout).split("\n")) {
    if (line === "") continue;
    const [field, value] = [line[0], line.slice(1)];
    if (field === "p") owner = { pid: Number(value), command: null };
    else if (owner === null) throw new Error(`lsof printed the field ${JSON.stringify(line)} before a process`);
    else if (field === "c") owner.command = value;
    else if (field === "f") files.push({ pid: owner.pid, command: owner.command, fd: value, type: null, name: null });
    else if (field !== "t" && field !== "n") throw new Error(`lsof printed the field ${JSON.stringify(line)}, which was not asked for`);
    else if (files.length === 0 || files.at(-1).pid !== owner.pid) throw new Error(`lsof printed the field ${JSON.stringify(line)} before a file`);
    else files.at(-1)[field === "t" ? "type" : "name"] = value;
  }
  return files;
}

// The probe of the locks of files. F_GETLK of fcntl(2) with a write lock over the whole file answers the first lock of
// another open file description that conflicts with it, a shared or an exclusive one. For a lock of flock(2) its l_pid is
// -1, because such a lock belongs to an open file description and not to a process; for a lock of fcntl it is the pid
// of the owner. struct flock of macOS is { off_t l_start; off_t l_len; pid_t l_pid; short l_type; short l_whence; }.
// No program of macOS other than perl calls fcntl for another file, and lsof reports no lock of flock on macOS.
const LOCK_PROBE = 'use Fcntl; for my $path (@ARGV) { my $f; unless (open($f, "<", $path)) { print "error\\t$!\\t$path\\n"; next } ' +
  'my $s = pack("q q l s s", 0, 0, 0, F_WRLCK, 0); unless (fcntl($f, F_GETLK, $s)) { print "error\\t$!\\t$path\\n"; next } ' +
  'my (undef, undef, $pid, $type) = unpack("q q l s s", $s); print $type == F_UNLCK ? "none\\t$path\\n" : "locked\\t$pid\\t$path\\n" }';

/**
 * The locks of paths that the output of LOCK_PROBE names, in the order of paths, as { path, lock } with lock `none`, or
 * { pid } of the holder (-1 for a lock of flock), or { error } when the probe could not open or ask the file. It fails
 * when the output does not answer each path in its order.
 */
export function probedLocks(paths, stdout) {
  const lines = String(stdout).split("\n").filter((line) => line !== "");
  if (lines.length !== paths.length) throw new Error(`the lock probe answered ${lines.length} of ${paths.length} files`);
  return paths.map((path, index) => {
    const fields = lines[index].split("\t");
    const answered = fields.slice(fields[0] === "none" ? 1 : 2).join("\t");
    if (answered !== path) throw new Error(`the lock probe answered ${JSON.stringify(lines[index])} for ${path}`);
    if (fields[0] === "none") return { path, lock: "none" };
    if (fields[0] === "locked" && /^-?\d+$/.test(fields[1])) return { path, lock: { pid: Number(fields[1]) } };
    if (fields[0] === "error") return { path, lock: { error: fields[1] } };
    throw new Error(`the lock probe answered ${JSON.stringify(lines[index])} for ${path}`);
  });
}

// The stdout of a command of the flock reading, or its failure with the command and its reason.
async function commandOutput(run, command, args) {
  const result = await run(command, args);
  const named = `${command} ${args.join(" ")}`;
  if (result.error) throw new Error(`${named}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${named} exited with ${result.status}: ${String(result.stderr).trim() || "no standard error"}`);
  return String(result.stdout);
}

/**
 * The file that process pid waits for in flock(2) and the process that holds its lock, read when the sample of pid in
 * file shows a thread in flock, as { file } or { fileError } and, with a file, { holder: { pid, command } } or
 * { holderError }. It is null when no thread waited in flock. macOS names no holder of a lock of flock, so the holder is
 * read from the files open:
 * - the file is the one regular file that pid has open on a numbered descriptor (`lsof -p`) and that holds a lock of
 *   flock (LOCK_PROBE); a file of none or of several is named as fileError.
 * - a lock of flock belongs to an open file description, so its holder has the file open: the holder is the one process
 *   other than pid that has the file open (`lsof -- <file>`), or pid itself when it has the file open more than once.
 *   No such process, or several, is named as holderError. lsof sees the processes of the same user only.
 * It fails with the reason when sample text, lsof or the probe cannot be read.
 *
 * run(command, args)  an executor that resolves to a process result ({status, stdout, stderr}). read(file) resolves to
 * the text of file. The checks replace both.
 */
export async function flockWait(pid, file, { run = runProcess, read = (path) => readFile(path, "utf8") } = {}) {
  if (!waitsInFlock(await read(file))) return null;
  const open = lsofFiles(await commandOutput(run, "/usr/sbin/lsof", ["-n", "-P", "-F", "pcftn", "-p", String(pid)]))
    .filter((entry) => entry.pid === pid && /^\d+$/.test(entry.fd) && entry.type === "REG");
  const paths = [...new Set(open.map((entry) => entry.name))];
  if (paths.length === 0) return { fileError: `process ${pid} has no regular file open` };
  const locks = probedLocks(paths, await commandOutput(run, "/usr/bin/perl", ["-e", LOCK_PROBE, "--", ...paths]));
  const unread = locks.filter(({ lock }) => lock.error !== undefined);
  if (unread.length > 0) return { fileError: `the lock of ${unread.map(({ path, lock }) => `${path} not read: ${lock.error}`).join(", ")}` };
  const flocked = locks.filter(({ lock }) => lock.pid === -1).map(({ path }) => path);
  if (flocked.length === 0) return { fileError: `no file that process ${pid} has open holds a lock of flock` };
  if (flocked.length > 1) return { fileError: `${flocked.length} files that process ${pid} has open hold a lock of flock: ${flocked.join(", ")}` };
  const [path] = flocked;
  const openers = lsofFiles(await commandOutput(run, "/usr/sbin/lsof", ["-n", "-P", "-F", "pcftn", "--", path]));
  const own = openers.filter((entry) => entry.pid === pid).length;
  const candidates = [...new Map(openers.filter((entry) => entry.pid !== pid || own > 1)
    .map((entry) => [entry.pid, { pid: entry.pid, command: entry.command }])).values()];
  if (candidates.length === 1) return { file: path, holder: candidates[0] };
  if (candidates.length === 0) return { file: path, holderError: `no other process of this user has ${path} open` };
  return { file: path, holderError: `one of the processes that have the file open holds it: ${candidates.map((c) => `${c.pid} ${c.command}`).join(", ")}` };
}

/** The fields of the stall record of a page process for the answer of flockWait, or "" when it waited in no flock. */
export function flockFields(wait) {
  if (wait === null) return "";
  if (wait.fileError !== undefined) return `; flock.file.error=${wait.fileError}`;
  const holder = wait.holder !== undefined ? `flock.holder=${wait.holder.pid} ${wait.holder.command}` : `flock.holder.error=${wait.holderError}`;
  return `; flock.file=${wait.file}; ${holder}`;
}

/**
 * Records the threads of the host host that did not answer and of its page processes pages in directory, and returns
 * for each process that file or the reason why it could not be recorded. The page may be read again and a WebContent
 * process may have ended, so when one process cannot be recorded the others are still recorded. It fails with the
 * reason when the host cannot be recorded. The file names share the host pid and time.
 */
export async function sampleStall({ host, pages, directory, time = Date.now(), sample = sampleProcess, flock = flockWait }) {
  const base = join(directory, `stall-${host}-${time}`);
  const results = await Promise.allSettled([host, ...pages].map(async (pid, index) => {
    if (index === 0) return sample(pid, `${base}.txt`);
    const file = await sample(pid, `${base}-page-${pid}.txt`);
    // A page process that waits in flock names the file and the holder of its lock; a failed reading is named instead.
    try {
      return `${file}${flockFields(await flock(pid, file))}`;
    } catch (error) {
      return `${file}; flock.error=${error.message}`;
    }
  }));
  if (results[0].status === "rejected") {
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length === 1) throw errors[0];
    throw joinedFailure(`the host ${host} and its pages were not sampled`, errors);
  }
  return results.map((result, index) => result.status === "fulfilled" ? result.value
    : `page ${pages[index - 1]} not sampled: ${result.reason.message}`);
}

/**
 * Stores the path of the dump of the host, the first of `records`, as the event `host.stall.dump` of the host
 * (`diagnostics.stall.dump`) and returns the text that names the position of the event in its log, or the reason why the host did not
 * store it. The request has no time limit: the answer of the host or the end of its connection, which rejects every pending
 * request, ends it, and the limit of the test runner bounds a host that stalls with its connection open.
 *
 * request(method, params)  sends a request of the endpoint. window is the window the request names.
 */
export async function announceStall(request, window, records, ...rest) {
  if (rest.length > 0) throw new TypeError("announceStall takes no limit: the request ends by the answer of the host or the end of its connection");
  try {
    const position = await request("diagnostics.stall.dump", { window, path: records[0] });
    return `host.stall.dump at ${position.boot}:${position.seq}`;
  } catch (error) {
    return `host.stall.dump not stored: ${error.message}`;
  }
}
