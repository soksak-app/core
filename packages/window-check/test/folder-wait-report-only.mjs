// A child process of test/folder-wait-drop.test.mjs, loaded with FSEVENTS_DROP_EVENTS=lost: one wait of untilFolderState on
// FOLDER, whose reads replace the content of a file, which leaves the time of the folder as it was. The first report of the
// folder adds the folder to the tree of the backend, and the second finds it unchanged and adds no event, so the wait sees
// the second content only when that report wakes it. The deadline of the wait is an hour, longer than the limit that the
// test gives this process.
//
//   node test/folder-wait-report-only.mjs FOLDER
import * as fs from "node:fs";
import { join } from "node:path";
import { untilFolderState } from "../folder-wait.mjs";

const [folder] = process.argv.slice(2);
if (!folder) throw new Error(`usage: folder-wait-report-only.mjs FOLDER, got ${process.argv.slice(2).join(" ")}`);

const HOUR_MS = 3600000;
const state = join(folder, "state");
fs.writeFileSync(state, "start");
let reads = 0;
await untilFolderState(folder, () => {
  reads += 1;
  if (reads <= 2) {
    fs.writeFileSync(state, `change ${reads}`);
    return undefined;
  }
  return fs.readFileSync(state, "utf8") === "change 2" ? reads : undefined;
}, HOUR_MS, () => new Error(`no change of ${folder} within ${HOUR_MS} ms`));
process.stdout.write("changed\n");
process.exit(0);
