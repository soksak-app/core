import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { censusRules, parseCensusConfig } from "../../packages/plugin-api/events-check.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG = "scripts/census.json";
const run = (...args) => spawnSync(process.execPath, [join(ROOT, "packages/plugin-api/events-check.js"), "--census", CONFIG, ...args], { cwd: ROOT, encoding: "utf8" });

test("the repository passes the census of its enabled rules and prints every pending rule with its item and count", () => {
  const output = run();
  assert.equal(output.status, 0, output.stderr);
  const config = parseCensusConfig(CONFIG, readFileSync(join(ROOT, CONFIG), "utf8"));
  for (const [rule, item] of Object.entries(config.pending)) {
    assert.match(output.stdout, new RegExp(`^pending ${item.replace(".", "\\.")}: ${rule.replace(".", "\\.")} is not enforced; \\d+ findings wait for it$`, "m"));
  }
  assert.match(output.stdout, /^Census passed: \d+ sources, \d+ rules pending$/m);
});

test("a rule waits only for an item of the checklist that is not complete, and a rule that has no findings is not pending", () => {
  const config = parseCensusConfig(CONFIG, readFileSync(join(ROOT, CONFIG), "utf8"));
  const features = readFileSync(join(ROOT, "docs/features.md"), "utf8");
  const output = run("--list");
  for (const [rule, item] of Object.entries(config.pending)) {
    const entry = features.split("\n").find((line) => line.includes(`${item} —`));
    assert.ok(entry, `${rule} waits for ${item}, which docs/features.md does not list`);
    assert.doesNotMatch(entry, /\[o\]/, `${rule} waits for ${item}, which is complete`);
    assert.match(output.stdout, new RegExp(`${rule.replace(".", "\\.")} (?:is outside its entrance files|has neither an event nor a stated reason)`), `${rule} is pending and has no finding`);
  }
  assert.ok(censusRules().length > Object.keys(config.pending).length, "every rule is pending");
});

test("the repository census declaration is read and rejects what it does not know", () => {
  const output = spawnSync(process.execPath, [join(ROOT, "packages/plugin-api/events-check.js"), "--census", "scripts/test/missing-census.json"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(output.status, 1);
  assert.match(output.stderr, /missing-census\.json/);
});
