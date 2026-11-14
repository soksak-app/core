// A command under test that records the SIGTERM it receives. Argument 2 is a folder and argument 3 is `exit` or `stay`. Once its
// SIGTERM handler is installed it renames the file `ready.tmp` to `ready`, which holds its pid; at SIGTERM it writes the file `term`.
// With `exit` it then exits with status 0, as a program that removes its partial output and ends; with `stay` it keeps running, as a
// program that ignores SIGTERM, so only SIGKILL ends it.
const { renameSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const [folder, mode] = process.argv.slice(2);
if (typeof folder !== 'string' || !['exit', 'stay'].includes(mode)) throw new Error(`usage: leader.cjs <folder> exit|stay, got ${JSON.stringify(process.argv.slice(2))}`);
process.on('SIGTERM', () => {
  writeFileSync(join(folder, 'term'), String(process.pid));
  if (mode === 'exit') process.exit(0);
});
writeFileSync(join(folder, 'ready.tmp'), String(process.pid));
renameSync(join(folder, 'ready.tmp'), join(folder, 'ready'));
setInterval(() => {}, 1000);
