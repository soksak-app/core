// The child process of test/platform/darwin/system/folder-wait-root-removal.test.mjs: it runs ROUNDS rounds of a wait of
// untilFolderState on a new folder under ROOT that ends at its first read after its watch is active, and removes the folder
// at once, as a check removes its folder in its after hook, so the end of the watch on a libuv worker thread overlaps the
// report of the removed root on the run loop thread of the FSEvents backend. ROOT holds no symbolic link, because FSEvents
// reports the path with its links resolved and the backend knows a removed root only by its path.
//
//   node test/folder-wait-root-removal.mjs ROOT ROUNDS
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { endWatches, untilFolderState } from "../folder-wait.mjs";

const [root, count] = process.argv.slice(2);
const rounds = Number(count);
if (!root || !Number.isInteger(rounds) || rounds < 1) throw new Error(`usage: folder-wait-root-removal.mjs ROOT ROUNDS, got ${process.argv.slice(2).join(" ")}`);
if (realpathSync(root) !== root) throw new Error(`${root} holds a symbolic link; FSEvents reports it as ${realpathSync(root)}`);

for (let round = 0; round < rounds; round++) {
  const folder = mkdtempSync(join(root, "round-"));
  await untilFolderState(folder, () => true);
  rmSync(folder, { recursive: true });
}
const failures = await endWatches();
for (const failure of failures) process.stderr.write(`${failure.message}\n`);
process.stdout.write(`rounds ${rounds}\n`);
process.exit(failures.length ? 1 : 0);
