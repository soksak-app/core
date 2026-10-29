#!/usr/bin/env node
// Finds native tests that no make target runs. A test source `native/darwin/tests/<name>_test.m` is run when the native
// suite variable NATIVE_TESTS lists it or a recipe line of native/darwin/Makefile names it; a test that neither names is
// built by no check and passes or fails unseen.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_SOURCE = /^native\/darwin\/tests\/(\w+_test)\.m$/;
const TEST_NAME = /\b(\w+_test)\b/g;

/** The test names that the suite variable lists and the recipe lines of the makefile name. */
export function runTestNames(makefile) {
  const names = new Set();
  const lines = makefile.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^NATIVE_TESTS\s*:?=/.test(lines[i])) {
      for (let j = i; j < lines.length; j++) {
        for (const match of lines[j].matchAll(TEST_NAME)) names.add(match[1]);
        if (!lines[j].endsWith("\\")) break;
      }
    } else if (lines[i].startsWith("\t")) {
      for (const match of lines[i].matchAll(TEST_NAME)) names.add(match[1]);
    }
  }
  return names;
}

/** The test sources among files whose test no make target runs. */
export function findUnrunTests(files, makefile) {
  const run = runTestNames(makefile);
  return files.filter((file) => TEST_SOURCE.test(file) && !run.has(TEST_SOURCE.exec(file)[1]));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = execFileSync("git", ["ls-files", "native/darwin/tests"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  const found = findUnrunTests(files, readFileSync(join(ROOT, "native/darwin/Makefile"), "utf8"));
  for (const file of found) console.error(`${file}: no make target runs ${basename(file, ".m")}`);
  if (found.length) {
    console.error(`Native test target checks failed: ${found.length} tests that no target runs`);
    process.exit(1);
  }
  console.log("Native test target checks passed");
}
