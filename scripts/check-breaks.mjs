/**
 * Apply each deliberate defect and require the suite to fail.
 *
 *   node scripts/check-breaks.mjs [id,id,...]
 *
 * Exits non-zero if any break survives or no longer applies.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { BREAKS } from "./breaks.mjs";

const HERE = new URL("../", import.meta.url).pathname;
const TESTS = readdirSync(`${HERE}test`)
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => `test/${f}`);
const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;

const originals = {};
for (const b of BREAKS) originals[b.file] ??= readFileSync(`${HERE}${b.file}`, "utf8");
const restore = () => {
  for (const [f, text] of Object.entries(originals)) writeFileSync(`${HERE}${f}`, text);
};
// Put the code back however this ends. A run killed by a timeout leaves a
// mutant in `dist` otherwise, and the next thing to read it sees a defect
// nobody wrote.
process.on("exit", restore);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}
process.on("uncaughtException", (e) => {
  restore();
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
  let passed = true;
  try {
    execFileSync("node", ["--test", ...TESTS], { cwd: HERE, stdio: "pipe", timeout: 300000 });
  } catch {
    passed = false;
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
