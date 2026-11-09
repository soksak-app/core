/**
 * Apply each deliberate defect and require the suite to fail.
 *
 *   node scripts/check-breaks.mjs [id,id,... | --required | --changed <range>] [--list]
 *
 * Exits non-zero if any break survives or no longer applies.
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BREAKS } from "./breaks.mjs";
import { evidenceFolder, mutationVerdict, runMutationTest } from "./mutation-runner.mjs";
import { changedMutationFiles, REQUIRED_BREAKS, selectRequiredBreaks } from "./required-breaks.mjs";
import { copyWorkspace } from "./workspace-copy.mjs";

const ROOT = new URL("../../../", import.meta.url).pathname;
// Listing and rejecting break ids need no copy, so they finish before one is made.
const arguments_ = process.argv.slice(2);
const listOnly = arguments_.includes("--list");
const argumentsWithoutList = arguments_.filter((argument) => argument !== "--list");
let required = null;
let only = null;
try {
  if (argumentsWithoutList[0] === "--changed" && argumentsWithoutList.length === 2) {
    required = selectRequiredBreaks(changedMutationFiles(ROOT, argumentsWithoutList[1]));
  } else if (argumentsWithoutList[0] === "--required" && argumentsWithoutList.length === 1) {
    required = [...REQUIRED_BREAKS];
  } else if (argumentsWithoutList.length > 1 || argumentsWithoutList[0]?.startsWith("-")) {
    throw new Error("Use break ids, --required or --changed <revision range>");
  } else if (argumentsWithoutList[0]) only = new Set(argumentsWithoutList[0].split(","));
  if (required) only = new Set(required.map(({ id }) => id));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const knownIds = new Set(BREAKS.map(({ id }) => id));
const unknownIds = only ? [...only].filter((id) => !knownIds.has(id)) : [];
if (unknownIds.length) {
  console.error(`Unknown break id(s): ${unknownIds.join(", ")}`);
  process.exit(2);
}

if (listOnly) {
  for (const entry of BREAKS) {
    if (!only || only.has(entry.id)) console.log(`${entry.id}\t${entry.file}\t${entry.what}`);
  }
  process.exit(0);
}

if (required?.length === 0) {
  console.log("No changed mutation owners");
  process.exit(0);
}

// The defects are written into a copy. Writing them into the repository leaves
// whatever else reads it — a build, an editor, another run — reading a defect
// nobody wrote, for as long as this takes.
const EVIDENCE = evidenceFolder(ROOT, "soksak-break-evidence-");
console.log(`Evidence: ${EVIDENCE}`);
const { top: TOP, root: HERE } = copyWorkspace("soksak-breaks-");
const drop = () => rmSync(TOP, { recursive: true, force: true });
// Take the copy away however this ends, including a run killed by a timeout.
process.on("exit", drop);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    drop();
    process.exit(130);
  });
}
process.on("uncaughtException", (e) => {
  drop();
  console.error(e);
  process.exit(1);
});

const TESTS = required ? [...new Set(required.flatMap(({ tests }) => tests))] : readdirSync(`${HERE}test`)
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => `test/${f}`);
/** The test files to run for a break, the one named after its file first. */
const order = (entry) => {
  if (required) return required.find(({ id }) => id === entry.id).tests;
  const file = entry.file;
  const named = `test/${file.replace(/^dist\//, "").replace(/\.js$/, "")}.test.mjs`;
  return TESTS.includes(named) ? [named, ...TESTS.filter((f) => f !== named)] : TESTS;
};

const originals = {};
for (const b of BREAKS) originals[b.file] ??= readFileSync(`${HERE}${b.file}`, "utf8");

// The baseline bound only stops a hang: a file that passes takes what it takes.
// `every invariant holds after each structural change` alone uses about 15 s of
// CPU time and took 20-23 s of wall time under other load, so no bound near
// that can tell a slow file from a hung one.
const BASELINE_TIMEOUT = 120_000;
// A break is bounded by its file's baseline time. Eight breaks run at once, and
// eight copies of that file took 22 s each where one took 21 s; three times the
// baseline leaves that and further load, while a break that makes the file hang
// still ends.
const baselineTime = {};
const breakTimeout = (file) => Math.max(20_000, 3 * baselineTime[file]);

const runFile = (root, file, timeout, label) => runMutationTest({
  root, file, timeout, evidence: join(EVIDENCE, label, file),
});

// A copy that does not pass before a break is applied measures nothing: the run
// below stops at the first file that fails, and that file would be the same one
// every time.
const broken = [];
for (const file of TESTS) {
  console.log(`START baseline test=${file} timeout_ms=${BASELINE_TIMEOUT}`);
  const result = await runFile(HERE, file, BASELINE_TIMEOUT, "baseline");
  baselineTime[file] = result.elapsed;
  if (result.classification !== "passed") broken.push(`${file} (${result.classification} after ${result.elapsed} ms)`);
  console.log(`${result.classification !== "passed" ? "FAIL" : "PASS"} baseline test=${file} result=${result.classification} elapsed_ms=${result.elapsed}`);
}
if (broken.length) {
  console.error(
    `The copy does not pass before a break is applied: ${broken.join(", ")}. Nothing to measure.`,
  );
  process.exit(2);
}

let caught = 0;
const missed = [];
const many = [];
const survived = [];
const invalid = [];
const applicable = [];
for (const b of BREAKS) {
  if (only && !only.has(b.id)) continue;
  const src = originals[b.file];
  const sites = src.split(b.find).length - 1;
  if (sites === 0) {
    missed.push(b);
    console.log(`${b.id.padEnd(14)} STALE     ${b.what}`);
    continue;
  }
  // `find` names one defect, and the write below replaces every occurrence of
  // it. A `find` matching more than one site removes several behaviours at
  // once and reports one result for all of them, so a site no test watches is
  // reported as caught on the strength of another site's tests.
  if (sites > 1) {
    many.push(b);
    console.log(`${b.id.padEnd(14)} ${String(sites)} SITES   ${b.what}`);
    continue;
  }
  applicable.push(b);
}

const run = async (b) => {
  const { top, root } = copyWorkspace("soksak-break-", { top: TOP, root: HERE });
  try {
    const src = originals[b.file];
    writeFileSync(`${root}${b.file}`, src.split(b.find).join(b.to));
    for (const file of order(b)) {
      const timeout = breakTimeout(file);
      console.log(`START break=${b.id} test=${file} timeout_ms=${timeout}`);
      const result = await runFile(root, file, timeout, b.id);
      const verdict = mutationVerdict(result);
      if (verdict !== "survived") {
        console.log(`${verdict === "caught" ? "PASS" : "FAIL"} break=${b.id} result=${result.classification} test=${file} elapsed_ms=${result.elapsed}`);
        return { b, verdict };
      }
      console.log(`PASS break=${b.id} test=${file} elapsed_ms=${result.elapsed}`);
    }
    console.log(`FAIL break=${b.id} result=survived`);
    return { b, verdict: "survived" };
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
};

const queue = [...applicable];
const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
  while (queue.length) {
    const b = queue.shift();
    if (!b) return;
    const result = await run(b);
    if (result.verdict === "caught") caught++;
    else if (result.verdict === "invalid") invalid.push(result.b);
    else survived.push(result.b);
  }
});
await Promise.all(workers);

console.log(
  `\ncaught ${caught} · survived ${survived.length} · stale ${missed.length} · ambiguous ${many.length} · invalid ${invalid.length}`,
);
if (survived.length) console.log("A break that survives names a promise no test holds the code to.");
if (missed.length) console.log("A stale break no longer applies: follow the code it patched, or delete it.");
if (many.length) {
  console.log(
    "A break matching more than one site measures several behaviours as one: anchor it to the " +
      "site it names, or write one entry per site.",
  );
}
writeFileSync(join(EVIDENCE, "summary.json"), `${JSON.stringify({ caught, survived, stale: missed, ambiguous: many, invalid }, null, 2)}\n`);
process.exit(invalid.length ? 2 : survived.length || missed.length || many.length ? 1 : 0);
