// The child process of test/folder-wait-stream-start.test.mjs: a worker thread creates, renames and removes files and
// nested folders in FOLDER without pause, and the main thread runs CYCLES waits of untilFolderState on FOLDER, each of
// which ends at the first change after its watch is active, so every watch starts and ends while changes arrive.
//
//   node test/folder-wait-churn.mjs FOLDER CYCLES
import { appendFileSync, readdirSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { endWatches, untilFolderState } from "../folder-wait.mjs";

const [folder, count] = process.argv.slice(2);
const cycles = Number(count);
if (!folder || !Number.isInteger(cycles) || cycles < 1) throw new Error(`usage: folder-wait-churn.mjs FOLDER CYCLES, got ${process.argv.slice(2).join(" ")}`);

// The progress file (test/churn-child.mjs) receives a line at the start and the end of each cycle, and from the writer every
// 100 changes; a run without FOLDER_WAIT_PROGRESS writes none.
const progressFile = process.env.FOLDER_WAIT_PROGRESS;
const progress = (line) => { if (progressFile) appendFileSync(progressFile, `${line}\n`); };
const writer = new Worker(new URL("./folder-wait-churn-writer.mjs", import.meta.url), { workerData: { folder, progressFile } });
// A change of the writer that fails names the state of the folder at that moment: whether it is still there and what it holds,
// so that a file or a folder that something else removed is told from a failure of the writer itself.
writer.on("error", (error) => {
  let entries;
  try {
    entries = readdirSync(folder, { recursive: true }).sort().join(", ");
  } catch (readError) {
    entries = `unreadable: ${readError.code ?? readError.message}`;
  }
  process.stderr.write(`writer: ${error.stack}\nfolder ${folder}: ${entries}\n`);
  process.exit(2);
});

for (let cycle = 0; cycle < cycles; cycle++) {
  let reads = 0;
  progress(`cycle ${cycle} waits`);
  // The first read runs when the watch is active; the second runs at a change.
  await untilFolderState(folder, () => {
    reads += 1;
    if (reads === 1) progress(`cycle ${cycle} watch active`);
    return reads > 1 ? reads : undefined;
  });
  progress(`cycle ${cycle} ended`);
}
progress("cycles ended");
await writer.terminate();
// A watch ends after its wait, on the thread of the file system events backend; a process that exits while one ends destroys
// the mutex that thread still locks, and libc++ ends it with SIGABRT. The process exits after every watch ended.
const failures = await endWatches();
for (const failure of failures) process.stderr.write(`${failure.message}\n`);
process.stdout.write(`cycles ${cycles}\n`);
process.exit(failures.length ? 1 : 0);
