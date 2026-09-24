/**
 * Apply each deliberate defect and require the suite to fail.
 *
 *   node scripts/check-breaks.mjs [id,id,...] [--list]
 *
 * Exits non-zero if any break survives or no longer applies.
 */
import { spawn } from "node:child_process";
import {
  cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BREAKS } from "./breaks.mjs";

const REPO = new URL("../", import.meta.url).pathname;
const ROOT = new URL("../../../", import.meta.url).pathname;
// Listing and rejecting break ids need no copy, so they finish before one is made.
const arguments_ = process.argv.slice(2);
const listOnly = arguments_.includes("--list");
const ids = arguments_.filter((argument) => argument !== "--list");
const only = ids[0] ? new Set(ids[0].split(",")) : null;
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

// The defects are written into a copy. Writing them into the repository leaves
// whatever else reads it — a build, an editor, another run — reading a defect
// nobody wrote, for as long as this takes.
// The copy keeps the workspace layout, because the suite reads the root's
// toolchain declarations through the same relative paths.
const TOP = `${mkdtempSync(join(tmpdir(), "soksak-breaks-"))}/`;
const HERE = `${TOP}packages/soksak/`;
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
for (const part of ["dist", "test", "scripts", "src", "docs", "package.json", "tsconfig.json"]) {
  cpSync(`${REPO}${part}`, `${HERE}${part}`, { recursive: true });
}
for (const part of ["package.json", "Makefile", ".node-version"]) {
  cpSync(`${ROOT}${part}`, `${TOP}${part}`, { recursive: true });
}
// The suite reads more than the built code: jsdom is what the view is rendered
// into. Link the tree rather than copy it — the run only reads it.
symlinkSync(`${REPO}node_modules`, `${HERE}node_modules`);

const TESTS = readdirSync(`${HERE}test`)
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => `test/${f}`);
/** The test files to run for a break, the one named after its file first. */
const order = (file) => {
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

/**
 * Run one test file in a copy. Bounded, so a hang cannot outlive it. The
 * result says whether it failed, whether the bound ended it, and how long it took.
 */
const runFile = (root, file, timeout) =>
  new Promise((done) => {
    const start = performance.now();
    const child = spawn(
      "node",
      [`${root}scripts/bounded.mjs`, String(timeout), "node", "--test", file],
      { cwd: root, stdio: "ignore" },
    );
    child.on("exit", (code) =>
      done({ failed: code !== 0, timedOut: code === 124, elapsed: Math.round(performance.now() - start) }));
  });

// A copy that does not pass before a break is applied measures nothing: the run
// below stops at the first file that fails, and that file would be the same one
// every time.
const broken = [];
for (const file of TESTS) {
  console.log(`START baseline test=${file} timeout_ms=${BASELINE_TIMEOUT}`);
  const result = await runFile(HERE, file, BASELINE_TIMEOUT);
  baselineTime[file] = result.elapsed;
  if (result.failed) broken.push(`${file} (${result.timedOut ? "timed out" : "failed"} after ${result.elapsed} ms)`);
  console.log(`${result.failed ? "FAIL" : "PASS"} baseline test=${file} elapsed_ms=${result.elapsed}`);
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

const copy = () => {
  const top = `${mkdtempSync(join(tmpdir(), "soksak-break-"))}/`;
  const root = `${top}packages/soksak/`;
  for (const part of ["dist", "test", "scripts", "src", "docs", "package.json", "tsconfig.json"])
    cpSync(`${REPO}${part}`, `${root}${part}`, { recursive: true });
  for (const part of ["package.json", "Makefile", ".node-version"])
    cpSync(`${ROOT}${part}`, `${top}${part}`, { recursive: true });
  symlinkSync(`${REPO}node_modules`, `${root}node_modules`);
  return { top, root };
};

const run = async (b) => {
  const { top, root } = copy();
  try {
    const src = originals[b.file];
    writeFileSync(`${root}${b.file}`, src.split(b.find).join(b.to));
    for (const file of order(b.file)) {
      const timeout = breakTimeout(file);
      console.log(`START break=${b.id} test=${file} timeout_ms=${timeout}`);
      const result = await runFile(root, file, timeout);
      if (result.failed) {
        // A break that makes the file hang is caught by the bound; the result names that.
        const how = result.timedOut ? "caught-by-timeout" : "caught";
        console.log(`PASS break=${b.id} result=${how} test=${file} elapsed_ms=${result.elapsed}`);
        return { b, caught: true };
      }
      console.log(`PASS break=${b.id} test=${file} elapsed_ms=${result.elapsed}`);
    }
    console.log(`FAIL break=${b.id} result=survived`);
    return { b, caught: false };
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
    if (result.caught) caught++;
    else survived.push(result.b);
  }
});
await Promise.all(workers);

console.log(
  `\ncaught ${caught} · survived ${survived.length} · stale ${missed.length} · ambiguous ${many.length}`,
);
if (survived.length) console.log("A break that survives names a promise no test holds the code to.");
if (missed.length) console.log("A stale break no longer applies: follow the code it patched, or delete it.");
if (many.length) {
  console.log(
    "A break matching more than one site measures several behaviours as one: anchor it to the " +
      "site it names, or write one entry per site.",
  );
}
process.exit(survived.length || missed.length || many.length ? 1 : 0);
