/**
 * Apply each deliberate defect and require the suite to fail.
 *
 *   node scripts/check-breaks.mjs [id,id,...]
 *
 * Exits non-zero if any break survives or no longer applies.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BREAKS } from "./breaks.mjs";

const REPO = new URL("../", import.meta.url).pathname;
// The defects are written into a copy. Writing them into the repository leaves
// whatever else reads it — a build, an editor, another run — reading a defect
// nobody wrote, for as long as this takes.
const HERE = `${mkdtempSync(join(tmpdir(), "soksak-breaks-"))}/`;
for (const part of ["dist", "test", "scripts", "package.json", "README.md"]) {
  cpSync(`${REPO}${part}`, `${HERE}${part}`, { recursive: true });
}
const drop = () => rmSync(HERE, { recursive: true, force: true });

const TESTS = readdirSync(`${HERE}test`)
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => `test/${f}`);
const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;

/** The test files to run for a break, the one named after its file first. */
const order = (file) => {
  const named = `test/${file.replace(/^dist\//, "").replace(/\.js$/, "")}.test.mjs`;
  return TESTS.includes(named) ? [named, ...TESTS.filter((f) => f !== named)] : TESTS;
};

const originals = {};
for (const b of BREAKS) originals[b.file] ??= readFileSync(`${HERE}${b.file}`, "utf8");
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

let caught = 0;
const missed = [];
const survived = [];
for (const b of BREAKS) {
  if (only && !only.has(b.id)) continue;
  const src = originals[b.file];
  if (!src.includes(b.find)) {
    missed.push(b);
    console.log(`${b.id.padEnd(14)} STALE     ${b.what}`);
    continue;
  }
  writeFileSync(`${HERE}${b.file}`, src.split(b.find).join(b.to));
  // One file at a time, stopping at the first that fails. What this run needs is
  // whether the suite fails at all, and running every file for a break the first
  // one already catches costs one process per file for nothing.
  //
  // The file named after the one the break patches goes first. It is a guess, and
  // a wrong guess costs the run that reaches the file that does fail.
  let passed = true;
  for (const file of order(b.file)) {
    try {
      execFileSync("node", ["--test", file], { cwd: HERE, stdio: "pipe", timeout: 300000 });
    } catch {
      passed = false;
      break;
    }
  }
  writeFileSync(`${HERE}${b.file}`, src);
  if (passed) {
    survived.push(b);
    console.log(`${b.id.padEnd(14)} SURVIVED  ${b.what}`);
  } else {
    caught++;
    console.log(`${b.id.padEnd(14)} caught    ${b.what}`);
  }
}

console.log(`\ncaught ${caught} · survived ${survived.length} · stale ${missed.length}`);
if (survived.length) console.log("A break that survives names a promise no test holds the code to.");
if (missed.length) console.log("A stale break no longer applies: follow the code it patched, or delete it.");
process.exit(survived.length || missed.length ? 1 : 0);
