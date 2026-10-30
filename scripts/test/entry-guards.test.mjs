import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// A module that runs as a command decides it from import.meta.main, so a process that imports it without a script path,
// such as node -e, imports it without running the command.
function importWithoutScriptPath(module) {
  const href = new URL(`../${module}`, import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import ${JSON.stringify(href)};`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("check-versions.mjs can be imported by a process that has no script path", { timeout: 10000 }, () => {
  importWithoutScriptPath("check-versions.mjs");
});

test("check-host-contract.mjs can be imported by a process that has no script path", { timeout: 10000 }, () => {
  importWithoutScriptPath("check-host-contract.mjs");
});

test("generate-event-classes.mjs can be imported by a process that has no script path", { timeout: 10000 }, () => {
  importWithoutScriptPath("generate-event-classes.mjs");
});
