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
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const HERE = new URL("../", import.meta.url).pathname;
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
const restore = () => {
  for (const f of FILES) writeFileSync(`${HERE}dist/${f}`, originals[f]);
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

const want = Number(process.argv[2] ?? 140);
const step = Math.max(1, Math.floor(sites.length / want));
const picked = sites.filter((_, i) => i % step === 0).slice(0, want);

// Awaited rather than run synchronously. A signal is delivered to the handlers
// above only when the loop turns, and a run that never turns it cannot be
// interrupted at all: those handlers replace Node's own, so Ctrl-C would leave
// the run going with a mutant in `dist`.
const passes = () =>
  new Promise((done) => {
    const child = spawn(
      "node",
      [`${HERE}scripts/bounded.mjs`, "300000", "node", "--test", ...TESTS],
      { cwd: HERE, stdio: "ignore" },
    );
    child.on("exit", (code) => done(code === 0));
  });

if (!(await passes())) {
  console.error("The suite does not pass before a single mutant is applied. Nothing to measure.");
  process.exit(2);
}

let killed = 0;
const alive = [];
for (const [i, s] of picked.entries()) {
  const src = originals[s.f];
  writeFileSync(`${HERE}dist/${s.f}`, src.slice(0, s.at) + s.to + src.slice(s.at + s.from.length));
  const survived = await passes();
  writeFileSync(`${HERE}dist/${s.f}`, src);
  if (survived) alive.push(s);
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
process.exit(0);
