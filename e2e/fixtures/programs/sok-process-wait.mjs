#!/usr/bin/env node
// A fixture program of the bundled sok executable for the tests of runSokProcessWait: it takes the arguments
// `process wait <pid> --config-dir <directory>` and answers `{"pid", "ended": true}` on the standard output once the operating
// system reports that the process of <pid> does not exist. It exits with status 1 and a message on the standard error for other
// arguments and for a process that still runs.
import { statSync } from "node:fs";

const [command, subcommand, pid, flag, directory, ...rest] = process.argv.slice(2);
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
if (command !== "process" || subcommand !== "wait" || flag !== "--config-dir" || rest.length > 0) {
  fail(`unexpected arguments ${JSON.stringify(process.argv.slice(2))}`);
}
if (!/^[1-9][0-9]*$/.test(pid)) fail(`process wait requires a PID, found ${JSON.stringify(pid)}`);
if (!statSync(directory).isDirectory()) fail(`${directory} is not a directory`);
try {
  process.kill(Number(pid), 0);
  fail(`process ${pid} still runs`);
} catch (error) {
  if (error.code !== "ESRCH") throw error;
}
process.stdout.write(`${JSON.stringify({ pid: Number(pid), ended: true })}\n`);
