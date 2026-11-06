/**
 * Flip one operator in the built code and see whether the suite notices.
 *
 * Coverage reports that a line ran. This reports whether a test checked what the
 * line did: a mutant the suite still passes is a line no test constrains.
 *
 *   node scripts/mutate.mjs [how many] [--list]
 *
 * Prints the score and, for every mutant that survived, the file, line and
 * edit — which is either a test worth writing or a branch worth deleting.
 */
import {
  cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutationVerdict, runMutationTest } from "./mutation-runner.mjs";

const REPO = new URL("../", import.meta.url).pathname;
const ROOT = new URL("../../../", import.meta.url).pathname;
// The mutants are written into a copy. Writing them into the repository leaves
// whatever else reads it — a build, an editor, another run — reading a defect
// nobody wrote, for as long as this takes, and a run killed outright leaves one
// there for good.
// The copy keeps the workspace layout, because the suite reads the root's
// toolchain declarations through the same relative paths.
const TOP = `${mkdtempSync(join(tmpdir(), "soksak-mutants-"))}/`;
const HERE = `${TOP}packages/soksak/`;
for (const part of ["dist", "test", "scripts", "src", "docs", "package.json", "tsconfig.json"]) {
  cpSync(`${REPO}${part}`, `${HERE}${part}`, { recursive: true });
}
for (const part of ["package.json", "Makefile", ".node-version"]) {
  cpSync(`${ROOT}${part}`, `${TOP}${part}`, { recursive: true });
}
for (const part of ["node-test-evidence.mjs", "test-event-reporter.mjs"]) {
  cpSync(`${ROOT}scripts/${part}`, `${TOP}scripts/${part}`);
}
// The suite reads more than the built code: jsdom is what the view is rendered
// into. Link the tree rather than copy it — the run only reads it.
symlinkSync(`${REPO}node_modules`, `${HERE}node_modules`);

const FILES = ["card.js", "slicing.js", "geometry.js", "outline.js", "soksak.js", "dom.js"];
// `node --test <dir>` picks up files that are not tests and fails on its own,
// which would score every mutant as caught. Name them.
const TESTS = readdirSync(`${HERE}test`)
  .filter((f) => f.endsWith(".test.mjs"))
  .map((f) => `test/${f}`);

// Operators only. They change what the code does without changing its shape,
// so a survivor is a claim nothing checks rather than a broken build.
const RULES = [
  [" >= ", " > "],
  [" <= ", " < "],
  [" === ", " !== "],
  [" !== ", " === "],
  [" && ", " || "],
  [" || ", " && "],
  ["Math.max(", "Math.min("],
  ["Math.min(", "Math.max("],
  [" + 1", " - 1"],
  [" - 1", " + 1"],
  [" / 2", " * 2"],
];

const originals = Object.fromEntries(FILES.map((f) => [f, readFileSync(`${HERE}dist/${f}`, "utf8")]));
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

const sites = [];
for (const f of FILES) {
  for (const [from, to] of RULES) {
    let at = originals[f].indexOf(from);
    while (at !== -1) {
      sites.push({ f, at, from, to });
      at = originals[f].indexOf(from, at + 1);
    }
  }
}
sites.sort((a, b) => (a.f === b.f ? a.at - b.at : a.f < b.f ? -1 : 1));

const listOnly = process.argv.includes("--list");
const countArgument = process.argv.slice(2).find((argument) => /^\d+$/.test(argument));
const want = Number(countArgument ?? 140);
const step = Math.max(1, Math.floor(sites.length / want));
const picked = sites.filter((_, i) => i % step === 0).slice(0, want);

if (listOnly) {
  console.log(`${sites.length} mutation candidates`);
  for (const site of sites) {
    const line = originals[site.f].slice(0, site.at).split("\n").length;
    console.log(`${site.f}:${line} ${JSON.stringify(site.from)} -> ${JSON.stringify(site.to)}`);
  }
  process.exit(0);
}

const EVIDENCE = mkdtempSync(join(process.env.SOKSAK_MUTATION_RUN_FOLDER ?? tmpdir(), "soksak-mutation-evidence-"));
console.log(`Evidence: ${EVIDENCE}`);
const runTests = async (label) => {
  for (const file of TESTS) {
    console.log(`START mutation=${label} test=${file}`);
    const result = await runMutationTest({ root: HERE, file, timeout: 120000, evidence: join(EVIDENCE, label, file) });
    console.log(`${result.classification === "passed" ? "PASS" : "FAIL"} mutation=${label} test=${file} result=${result.classification} elapsed_ms=${result.elapsed}`);
    if (result.classification !== "passed") return result;
  }
  return { classification: "passed" };
};
if ((await runTests("baseline")).classification !== "passed") {
  console.error("The suite does not pass before a single mutant is applied. Nothing to measure.");
  process.exit(2);
}

let killed = 0;
const alive = [];
for (const [i, s] of picked.entries()) {
  const src = originals[s.f];
  writeFileSync(`${HERE}dist/${s.f}`, src.slice(0, s.at) + s.to + src.slice(s.at + s.from.length));
  const result = await runTests(`mutant-${i + 1}`);
  const verdict = mutationVerdict(result);
  writeFileSync(`${HERE}dist/${s.f}`, src);
  if (verdict === "invalid") {
    console.error(`The mutation experiment failed: ${result.record}`);
    process.exit(2);
  }
  if (verdict === "survived") alive.push(s);
  else killed++;
  if ((i + 1) % 10 === 0) process.stderr.write(`  ${i + 1}/${picked.length} (survived ${alive.length})\n`);
}

console.log(`${picked.length} mutants of ${sites.length} candidates`);
console.log(`  killed ${killed} · survived ${alive.length}`);
console.log(`  score ${((killed / picked.length) * 100).toFixed(1)}%`);
if (alive.length) {
  console.log("\nSurvived — nothing is holding these to account:");
  for (const s of alive) {
    const line = originals[s.f].slice(0, s.at).split("\n").length;
    const text = originals[s.f].split("\n")[line - 1].trim();
    console.log(`  ${s.f}:${line}  ${JSON.stringify(s.from)} -> ${JSON.stringify(s.to)}`);
    console.log(`      ${text.slice(0, 110)}`);
  }
  console.log(
    "\nEach is a test worth writing, a branch worth deleting, or an edit a caller " +
      "cannot tell apart — say which before leaving it.",
  );
}
writeFileSync(join(EVIDENCE, "summary.json"), `${JSON.stringify({ candidates: sites.length, measured: picked.length, killed, survived: alive }, null, 2)}\n`);
process.exit(0);
