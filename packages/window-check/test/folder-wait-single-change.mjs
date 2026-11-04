// A child process of test/folder-wait-drop.test.mjs: one wait of untilFolderState on FOLDER, whose first read makes the
// only change of the folder. The deadline of the wait is an hour, longer than the limit that the test gives this process,
// so the process ends with its line only when the report of the change wakes the wait.
//
//   node test/folder-wait-single-change.mjs FOLDER
import * as fs from "node:fs";
import { join } from "node:path";
import { untilFolderState } from "../folder-wait.mjs";

const [folder] = process.argv.slice(2);
if (!folder) throw new Error(`usage: folder-wait-single-change.mjs FOLDER, got ${process.argv.slice(2).join(" ")}`);

const HOUR_MS = 3600000;
const state = join(folder, "state");
let reads = 0;
await untilFolderState(folder, () => {
  reads += 1;
  if (reads > 1) return fs.existsSync(state) ? reads : undefined;
  fs.writeFileSync(state, "changed");
  return undefined;
}, HOUR_MS, () => new Error(`no change of ${folder} within ${HOUR_MS} ms`));
process.stdout.write("changed\n");
process.exit(0);
