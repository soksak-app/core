// Keeps the thread stacks of a host that does not answer, at that moment. What the main thread did while a request did
// not answer within the limit can be seen only then, so the check records every thread of the host process at that
// moment with sample of macOS. A process of the same user can be sampled without privilege.
import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";

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
 * Records the threads of the host host that did not answer and of its page processes pages in directory, and returns
 * for each process that file or the reason why it could not be recorded. The page may be read again and a WebContent
 * process may have ended, so when one process cannot be recorded the others are still recorded. It fails with the
 * reason when the host cannot be recorded. The file names share the host pid and time.
 */
export async function sampleStall({ host, pages, directory, time = Date.now(), sample = sampleProcess }) {
  const base = join(directory, `stall-${host}-${time}`);
  const results = await Promise.allSettled([host, ...pages].map(async (pid, index) =>
    sample(pid, index === 0 ? `${base}.txt` : `${base}-page-${pid}.txt`)));
  if (results[0].status === "rejected") {
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
  }
  return results.map((result, index) => result.status === "fulfilled" ? result.value
    : `page ${pages[index - 1]} not sampled: ${result.reason.message}`);
}

/**
 * Stores the path of the dump of the host, the first of `records`, as the event `host.stall.dump` of the host
 * (`diagnostics.stall.dump`) and returns the text that names the position of the event in its log, or the reason why the host did not
 * store it. A host that stalls may answer late or never, so the request is bounded by `ms`.
 *
 * request(method, params)  sends a request of the endpoint. window is the window the request names.
 */
export async function announceStall(request, window, records, ms = 5000) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms); });
  try {
    const position = await Promise.race([request("diagnostics.stall.dump", { window, path: records[0] }), limit]);
    return `host.stall.dump at ${position.boot}:${position.seq}`;
  } catch (error) {
    return `host.stall.dump not stored: ${error.message}`;
  } finally {
    clearTimeout(timer);
  }
}
