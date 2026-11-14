// Writes the temporary folder that the test runner gives this process to the file `seen` of the folder that OUT names: the folder as
// given, its real path, its mode and its owner.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const status = fs.statSync(os.tmpdir());
const seen = path.join(process.env.OUT, 'seen');
fs.writeFileSync(seen, JSON.stringify({ given: os.tmpdir(), real: fs.realpathSync(os.tmpdir()), mode: status.mode & 0o777, uid: status.uid }));
