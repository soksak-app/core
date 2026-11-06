// Runs test/folder-wait-churn.mjs in a child process and bounds it by its progress, not by its total time: the child writes a
// line to its progress file at the start and the end of each cycle and the writer thread writes one every 100 changes, and a
// child whose file did not grow for STALL_MS stopped and ends with SIGKILL. A slow child that goes on is not ended, since a
// cycle may wait up to the deadline of 10 s on a loaded machine. The result of a stopped child holds `stalled`, the last line of
// its progress, which names the cycle and whether the wait or the writer stopped.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
// The deadline of a wait (10 s) and a margin: a child that does not grow its file for longer stopped.
export const STALL_MS = 20000;
// The longest run of a child that keeps its progress: 20 cycles that each end at the deadline of 10 s, and a margin.
export const CHURN_TEST_LIMIT_MS = 240000;

/** Runs the churn child on watched for cycles, with env, and resolves with its code, signal and outputs. */
export function runChurn(watched, cycles, env, progressFolder) {
  const progress = join(progressFolder, "progress");
  fs.writeFileSync(progress, "");
  return new Promise((resolve) => {
    let stalled = null;
    // Each change of the progress file starts the stall time again; a child whose file stays the same for STALL_MS stopped.
    const stall = setTimeout(() => {
      const lines = fs.readFileSync(progress, "utf8").trimEnd().split("\n");
      stalled = `no progress for ${STALL_MS} ms after: ${lines.at(-1)}`;
      child.kill("SIGKILL");
    }, STALL_MS);
    const watcher = fs.watch(progress, () => stall.refresh());
    const child = execFile(process.execPath, [join(here, "folder-wait-churn.mjs"), watched, String(cycles)],
      { env: { ...env, FOLDER_WAIT_PROGRESS: progress } },
      (error, stdout, stderr) => {
        clearTimeout(stall);
        watcher.close();
        const result = { code: error ? error.code ?? null : 0, signal: error?.signal ?? null, stdout, stderr };
        resolve(stalled === null ? result : { ...result, stalled });
      });
  });
}
