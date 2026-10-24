#!/usr/bin/env node
// Runs one window check in sequence for the given number of times and stops at the first failed run.
//
// soksak-window-repeat --setup ./setup.mjs --file <check file> --name "<check name>" --count 16
//
// An intermittent failure is reproduced and accepted with this target. Each run uses a new node:test process and does
// not launch an application. SOKSAK_APP selects one host. The check file and the launch start module of --setup are
// relative to the current folder of the calling repository.
import { spawnSync } from "node:child_process";
import { sessionBaselineEnvironment } from "./frontmost.mjs";

const USAGE = "usage: soksak-window-repeat --setup <global setup module> --file <test file> --name <test name pattern> --count <n>";
const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  const value = args[i + 1];
  if (!["--setup", "--file", "--name", "--count"].includes(key) || value === undefined || key.slice(2) in options) {
    console.error(USAGE);
    process.exit(2);
  }
  options[key.slice(2)] = value;
}
const count = Number(options.count);
if (!options.setup || !options.file || !options.name || !Number.isInteger(count) || count < 1) {
  console.error(USAGE);
  process.exit(2);
}

const pattern = new RegExp(options.name);
const env = sessionBaselineEnvironment();
for (let run = 1; run <= count; run++) {
  // The number of checks that ran is counted from TAP, the machine format. The human-readable output carries color
  // codes depending on the environment. When no check matches the name, the file itself is reported as one result line,
  // so only results whose title matches the name pattern and that were not skipped are counted.
  const result = spawnSync(process.execPath,
    ["--test", "--test-concurrency=1", `--test-global-setup=${options.setup}`, "--test-reporter=tap", `--test-name-pattern=${options.name}`, options.file],
    { encoding: "utf8", env: { ...process.env, ...env } });
  const output = `${result.stdout}${result.stderr}`;
  const passed = result.stdout.split("\n")
    .map((line) => /^\s*ok \d+ - (.*)$/.exec(line)?.[1])
    .filter((title) => title !== undefined && !/# SKIP/.test(title) && pattern.test(title)).length;
  if (result.status !== 0) {
    process.stdout.write(output);
    console.error(`FAIL run ${run} of ${count}: ${options.file} "${options.name}"`);
    process.exit(1);
  }
  if (passed === 0) {
    console.error(`FAIL run ${run} of ${count}: no test ran for "${options.name}" in ${options.file} (none matched or all were skipped)`);
    process.exit(1);
  }
  console.log(`PASS run ${run} of ${count}: ${passed} tests`);
  // Prints the measurements that a check left with t.diagnostic for each run. In TAP a diagnostic is a `#` line before
  // the top-level plan line (`1..N`), and a `#` line after the plan line is the run summary.
  for (const line of result.stdout.split("\n")) {
    if (/^1\.\.\d+$/.test(line)) break;
    const diagnostic = /^\s*# (.*)$/.exec(line)?.[1];
    if (diagnostic !== undefined && !/^Subtest: /.test(diagnostic)) console.log(`  ${diagnostic}`);
  }
}
console.log(`PASS ${count} runs: ${options.file} "${options.name}"`);
