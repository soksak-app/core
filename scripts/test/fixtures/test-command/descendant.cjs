// A descendant process of a command under test, started with an IPC channel: it writes the file that argument 2 names when it receives
// SIGTERM, tells its parent that it is ready, and stays alive.
const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => writeFileSync(process.argv[2], 'term'));
process.send('ready');
setInterval(() => {}, 1000);
