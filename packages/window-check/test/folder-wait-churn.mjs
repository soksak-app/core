// The child process of test/folder-wait-stream-start.test.mjs: a worker thread creates, renames and removes files and
// nested folders in FOLDER without pause, and the main thread runs CYCLES waits of untilFolderState on FOLDER, each of
// which ends at the first change after its watch is active, so every watch starts and ends while changes arrive.
//
//   node test/folder-wait-churn.mjs FOLDER CYCLES
import { Worker } from "node:worker_threads";
import { untilFolderState } from "../folder-wait.mjs";

const [folder, count] = process.argv.slice(2);
const cycles = Number(count);
if (!folder || !Number.isInteger(cycles) || cycles < 1) throw new Error(`usage: folder-wait-churn.mjs FOLDER CYCLES, got ${process.argv.slice(2).join(" ")}`);

const writer = new Worker(`
const fs = require("node:fs");
const { join } = require("node:path");
const { workerData: folder } = require("node:worker_threads");
for (let i = 0; ; i++) {
  const nested = join(folder, "nested-" + (i % 4));
  fs.mkdirSync(join(nested, "a", "b"), { recursive: true });
  fs.writeFileSync(join(nested, "a", "file"), String(i));
  fs.renameSync(join(nested, "a", "file"), join(nested, "moved"));
  fs.writeFileSync(join(folder, ".state.tmp"), String(i));
  fs.renameSync(join(folder, ".state.tmp"), join(folder, "state"));
  fs.rmSync(nested, { recursive: true });
}
`, { eval: true, workerData: folder });
writer.on("error", (error) => {
  process.stderr.write(`writer: ${error.stack}\n`);
  process.exit(2);
});

for (let cycle = 0; cycle < cycles; cycle++) {
  let reads = 0;
  // The first read runs when the watch is active; the second runs at a change.
  await untilFolderState(folder, () => (++reads > 1 ? reads : undefined), 10000,
    () => new Error(`cycle ${cycle}: no change of ${folder} within 10000 ms`));
}
process.stdout.write(`cycles ${cycles}\n`);
process.exit(0);
