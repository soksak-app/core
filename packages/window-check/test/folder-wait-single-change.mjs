// A child process of test/folder-wait-drop.test.mjs: one wait of untilFolderState on FOLDER, whose first read makes the
// only change of the folder. The wait has no time limit, and the limit that the test gives this process bounds it, so the
// process ends with its line only when the report of the change wakes the wait.
//
//   node test/folder-wait-single-change.mjs FOLDER
import * as fs from "node:fs";
import { join } from "node:path";
import { endWatches, untilFolderState } from "../folder-wait.mjs";

const [folder] = process.argv.slice(2);
if (!folder) throw new Error(`usage: folder-wait-single-change.mjs FOLDER, got ${process.argv.slice(2).join(" ")}`);

const state = join(folder, "state");
let reads = 0;
await untilFolderState(folder, () => {
  reads += 1;
  if (reads > 1) return fs.existsSync(state) ? reads : undefined;
  fs.writeFileSync(state, "changed");
  return undefined;
});
// A watch ends after its wait, on the thread of the file system events backend; a process that exits while one ends destroys
// the mutex that thread still locks, and libc++ ends it with SIGABRT. The process exits after every watch ended.
const failures = await endWatches();
for (const failure of failures) process.stderr.write(`${failure.message}\n`);
process.stdout.write("changed\n");
process.exit(failures.length ? 1 : 0);
