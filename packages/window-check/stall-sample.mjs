// Keeps the thread stacks of a host that does not answer, at that moment. What the main thread did while a request did
// not answer within the limit can be seen only then, so the check records every thread of the host process at that
// moment with sample of macOS. A process of the same user can be sampled without privilege.
import { execFile } from "node:child_process";
import { join } from "node:path";

/** The seconds in which sample watches the host. One short record shows the stack of the blocked main thread. */
const SECONDS = 2;

// Child operations have their own limit and never block endpoint reads or test deadlines.
function runProcess(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: 10000 }, (error, stdout, stderr) => {
      resolve({ status: error?.code ?? 0, stdout, stderr,
        error: error && typeof error.code !== "number" ? error : undefined });
    });
  });
}


/**
 * The milliseconds that a request may stay pending before the check samples the host and its page processes. A pending
 * request has no event source: it is pending exactly while nothing comes back, so a timer per pending request is the only
 * source of the mark. A stall that ends before the request limit is recorded only when it starts at this mark.
 */
export const STALL_AFTER = 3000;

/**
 * Writes the thread stacks of process pid to file and returns file. It fails with the reason when sample fails.
 *
 * run(command, args)  an executor that resolves to a process result ({status, stderr}). The checks replace it.
 */
export async function sampleProcess(pid, file, run = runProcess) {
  const result = await run("/usr/bin/sample", [String(pid), String(SECONDS), "-file", file]);
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
