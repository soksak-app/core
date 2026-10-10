// Keeps the thread stacks of a host that does not answer, at that moment. What the main thread did while a request did
// not answer within the limit can be seen only then, so the check records every thread of the host process at that
// moment with sample of macOS. A process of the same user can be sampled without privilege.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
 * Among the WebKit children that the host recorded (webkit-children.json in the configuration folder), the WebContent
 * process that runs the page. While the page does not answer, its JavaScript runs in this process and not in the host,
 * so it is recorded too. It fails when the record is missing or has another format.
 */
export function pageProcesses(configDir) {
  const file = join(configDir, "webkit-children.json");
  let record;
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
  if (!Array.isArray(record.children)) throw new Error(`${file}: children is not a list`);
  return record.children.filter((child) => child.kind === "WebContent").map((child) => child.pid);
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
