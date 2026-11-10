// The child process of test/platform/darwin/system/folder-wait-overlap.test.mjs: it runs ROUNDS rounds of waits of
// untilFolderState on the folders under ROOT, each of which ends at its first read after its watch is active. In each round a
// wait on one folder ends, and its watch ends after it on a libuv worker thread, while three waits on other folders start
// their watches on the JavaScript thread, so the end of a watch overlaps the start of the next ones, as the callers of the
// wait do one after another.
//
//   node test/folder-wait-overlap.mjs ROOT ROUNDS
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { endWatches, untilFolderState } from "../folder-wait.mjs";

const [root, count] = process.argv.slice(2);
const rounds = Number(count);
if (!root || !Number.isInteger(rounds) || rounds < 1) throw new Error(`usage: folder-wait-overlap.mjs ROOT ROUNDS, got ${process.argv.slice(2).join(" ")}`);

const folders = Array.from({ length: 16 }, (_, index) => {
  const folder = join(root, `folder-${index}`);
  mkdirSync(folder);
  return folder;
});
// A wait that ends at the read after its watch is active.
const active = (round, folder) => untilFolderState(folder, () => true, 10000,
  () => new Error(`round ${round}: the watch of ${folder} was not active within 10000 ms`));

for (let round = 0; round < rounds; round++) {
  await active(round, folders[round % folders.length]);
  // The end of the watch of that wait is called in a later microtask of its settling; the next waits start after the
  // microtasks ran, so the end is called before their starts, and it runs on its worker while they start.
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all([1, 2, 3].map((step) => active(round, folders[(round + step) % folders.length])));
}
// A process that exits while a watch ends destroys the mutex that the thread of the backend still locks, so the process exits
// after every watch ended.
const failures = await endWatches(10000);
for (const failure of failures) process.stderr.write(`${failure.message}\n`);
process.stdout.write(`rounds ${rounds}\n`);
process.exit(failures.length ? 1 : 0);
