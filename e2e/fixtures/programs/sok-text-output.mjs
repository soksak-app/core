#!/usr/bin/env node
// A fixture program of the bundled sok executable for the malformed-output test of runSokProcessWait: it writes its arguments as text
// on the standard output and exits with status 0, which is no JSON answer of `process wait`.
process.stdout.write(`${process.argv.slice(2).join(" ")}\n`);
