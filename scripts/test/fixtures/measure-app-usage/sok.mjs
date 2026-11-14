#!/usr/bin/env node
// A fixture program of the sok executable for the system tests of measureApps: it answers the two requests of the measurement from
// the files of the configuration folder that it is given. `windows --config-dir DIR` prints DIR/windows.json, and
// `status host.window --window W --config-dir DIR` prints DIR/host-window-W.json. It exits with status 1 and a message on the
// standard error for other arguments and for a missing file.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const directory = option("--config-dir");
if (directory === undefined) fail(`no --config-dir in ${JSON.stringify(args)}`);
let file;
if (args[0] === "windows" && args.length === 3) file = "windows.json";
else if (args[0] === "status" && args[1] === "host.window" && args[2] === "--window" && args.length === 6) file = `host-window-${args[3]}.json`;
else fail(`unexpected arguments ${JSON.stringify(args)}`);
try {
  process.stdout.write(readFileSync(join(directory, file), "utf8"));
} catch (error) {
  fail(error.message);
}
