// Runs, before a push, every static check that the CI jobs of linux-node, equivalence and the host jobs run through make.
// The list is read from the job steps of .github/workflows/ci.yml, and a target is static when its Makefile rule has no
// prerequisite that builds, copies or packs an artifact. The targets run in CI order and the run stops at the first failure.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const JOBS = ["linux-node", "equivalence", "macos-wailsv3", "macos-tauriv2", "macos-mygo", "macos-gpuikit"];
const TARGET_TIMEOUT_MS = 900000;
const NON_STATIC_PREREQUISITE = /^(build|copy|pack|release|fetch|install)-|^(build|copy|pack|release|fetch|install)$/;

const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const makefile = readFileSync(join(ROOT, "Makefile"), "utf8");

// Jobs are the two-space keys under `jobs:`; each job runs from its key line to the next job key.
function jobText(name) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`ci.yml has no job named ${name}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [a-z0-9-]+:$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

// A make invocation in a step: `make -C core <targets and VAR=value arguments>`. Variables and shell expansions are dropped.
function stepTargets(text) {
  const targets = [];
  for (const match of text.matchAll(/make -C core ([^\n]*)/g)) {
    for (const word of match[1].split(/\s+/)) {
      if (word === "" || word.includes("=") || word.includes("$") || word.startsWith("-")) continue;
      if (/^[a-z][a-z0-9-]*$/.test(word)) targets.push(word);
    }
  }
  return targets;
}

// A rule of the Makefile: `name: prerequisites`, read from the first line of the rule.
function prerequisites(target) {
  const line = makefile.split("\n").find((text) => text.startsWith(`${target}:`));
  if (line === undefined) throw new Error(`Makefile has no rule for ${target}`);
  return line.slice(target.length + 1).trim().split(/\s+/).filter((word) => word !== "");
}

const selected = [];
for (const job of JOBS) {
  for (const target of stepTargets(jobText(job))) {
    if (!selected.includes(target)) selected.push(target);
  }
}
// The headless owner tests of linux-node run after the sok build of the same job, which the tests need when it is missing.
const SAME_AS_CI = ["build-sok", "test-headless-owners"];
const runnable = [];
for (const target of selected) {
  if (SAME_AS_CI.includes(target)) {
    runnable.push(target);
    continue;
  }
  if (!target.startsWith("check-")) continue;
  const blocked = prerequisites(target).find((name) => NON_STATIC_PREREQUISITE.test(name));
  if (blocked !== undefined) {
    console.log(`skip ${target}: its prerequisite ${blocked} builds or copies an artifact (not static)`);
    continue;
  }
  runnable.push(target);
}

// The revision range of the pre-push checks, the same default that check-push uses (Makefile).
const PUSH_RANGE = "origin/main..HEAD";
// Targets that require a revision range as a variable; the step variable is dropped by stepTargets, so the range is passed here.
const RANGE_ARGUMENT = { "check-commits": `RANGE=${PUSH_RANGE}`, "check-checklist-history": `RANGE=${PUSH_RANGE}` };
const argumentsOf = (target) => (RANGE_ARGUMENT[target] === undefined ? [] : [RANGE_ARGUMENT[target]]);

console.log(`preflight targets (${runnable.length}): ${runnable.join(" ")}`);
if (process.argv.includes("--list")) {
  // The list mode prints the derived targets in CI order and runs none of them.
  for (const target of runnable) console.log(`target ${[target, ...argumentsOf(target)].join(" ")}`);
  process.exit(0);
}
let failed = null;
for (const target of runnable) {
  console.log(`running ${target}`);
  const started = Date.now();
  const result = spawnSync("make", ["--no-print-directory", target, ...argumentsOf(target)], {
    cwd: ROOT,
    stdio: "inherit",
    timeout: TARGET_TIMEOUT_MS,
  });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) {
    failed = `${target}: ${result.error.message}`;
    console.log(`failed ${target} after ${elapsed} s: ${result.error.message}`);
    break;
  }
  if (result.status !== 0) {
    failed = `${target}: exit ${result.status}`;
    console.log(`failed ${target} after ${elapsed} s: exit ${result.status}`);
    break;
  }
  console.log(`passed ${target} in ${elapsed} s`);
}

if (failed !== null) {
  console.error(`preflight stopped at the first failing target: ${failed}`);
  process.exit(1);
}
console.log(`preflight passed: ${runnable.length} targets`);
