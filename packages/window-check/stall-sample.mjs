// Keeps the thread stacks of a host that does not answer, at that moment. What the main thread did while a request did
// not answer within the limit can be seen only then, so the check records every thread of the host process at that
// moment with sample of macOS. A process of the same user can be sampled without privilege.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** The seconds in which sample watches the host. One short record shows the stack of the blocked main thread. */
const SECONDS = 2;

/**
 * Writes the thread stacks of process pid to file and returns file. It fails with the reason when sample fails.
 *
 * run(command, args)  an executor that returns the same result as spawnSync ({status, stderr}). The checks replace it.
 */
export function sampleProcess(pid, file, run = (command, args) => spawnSync(command, args, { encoding: "utf8" })) {
  const result = run("/usr/bin/sample", [String(pid), String(SECONDS), "-file", file]);
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
 * run(command, args)  an executor that returns the same result as spawnSync ({status, stdout, stderr}). The checks replace it.
 */
export function launchdServices(host, run = (command, args) => spawnSync(command, args, { encoding: "utf8" })) {
  const result = run("/bin/launchctl", ["print", `pid/${host}`]);
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
 * run(command, args)  an executor that returns the same result as spawnSync ({status, stdout, stderr}). The checks replace it.
 */
export function pageProcesses(host, run = (command, args) => spawnSync(command, args, { encoding: "utf8" })) {
  return launchdServices(host, run)
    .filter(({ label }) => label.startsWith("com.apple.WebKit.WebContent."))
    .map(({ pid }) => pid);
}

/**
 * Records the threads of the host host that did not answer and of its page processes pages in directory, and returns
 * for each process that file or the reason why it could not be recorded. The page may be read again and a WebContent
 * process may have ended, so when one process cannot be recorded the others are still recorded. It fails with the
 * reason when the host cannot be recorded. The file names share the host pid and time.
 */
export function sampleStall({ host, pages, directory, time = Date.now(), sample = sampleProcess }) {
  const base = join(directory, `stall-${host}-${time}`);
  const records = [sample(host, `${base}.txt`)];
  for (const pid of pages) {
    try {
      records.push(sample(pid, `${base}-page-${pid}.txt`));
    } catch (error) {
      records.push(`page ${pid} not sampled: ${error.message}`);
    }
  }
  return records;
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
