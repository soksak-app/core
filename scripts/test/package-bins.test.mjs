import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditBins, binTargets, repositoryBins } from "../check-package-bins.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("every package bin target of the repository is tracked as executable with a #! line", { timeout: 10000 }, () => {
  assert.deepEqual(auditBins(repositoryBins(root)), []);
});

test("bin targets resolve against the folder of their package.json", { timeout: 1000 }, () => {
  assert.deepEqual(binTargets("packages/a/package.json", JSON.stringify({ name: "a", bin: { a: "./bin.js", b: "x/b.mjs" } })), [
    "packages/a/bin.js",
    "packages/a/x/b.mjs",
  ]);
  assert.deepEqual(binTargets("packages/c/package.json", JSON.stringify({ name: "c", bin: "c.js" })), ["packages/c/c.js"]);
  assert.deepEqual(binTargets("package.json", JSON.stringify({ name: "w" })), []);
});

test("a bin target tracked as 100644 or without a #! line is an error that names the file", { timeout: 1000 }, () => {
  assert.deepEqual(auditBins([
    { path: "packages/a/ok.js", mode: "100755", head: "#!/usr/bin/env node" },
    { path: "packages/a/mode.js", mode: "100644", head: "#!/usr/bin/env node" },
    { path: "packages/a/head.js", mode: "100755", head: "import x from 'y';" },
  ]), [
    "packages/a/mode.js: a package bin target is tracked with mode 100644, not 100755",
    "packages/a/head.js: a package bin target does not start with a #! line",
  ]);
});
