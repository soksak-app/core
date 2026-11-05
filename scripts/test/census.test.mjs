import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { censusRules, emitFindings, parseCensusConfig } from "@soksak/kit-checks/census";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG = "scripts/census.json";
const CHECK = fileURLToPath(import.meta.resolve("@soksak/kit-checks/check"));
const run = (...args) => spawnSync(process.execPath, [CHECK, "census", "--config", CONFIG, ...args], { cwd: ROOT, encoding: "utf8" });

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
    assert.match(output.stdout, new RegExp(`${rule.replace(".", "\\.")} (?:is outside its entrance files|has neither an event nor a stated reason|is a poisoned lock that is not recovered)`), `${rule} is pending and has no finding`);
  }
  assert.ok(censusRules().length > Object.keys(config.pending).length, "every rule is pending");
});

test("the repository census declaration is read and rejects what it does not know", () => {
  const output = spawnSync(process.execPath, [CHECK, "census", "--config", "scripts/test/missing-census.json"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(output.status, 1);
  assert.match(output.stderr, /missing-census\.json/);
});

test("the catalog check refuses an event of a Go source of the mygo workbench that the catalog does not declare", () => {
  const config = parseCensusConfig(CONFIG, readFileSync(join(ROOT, CONFIG), "utf8"));
  const catalog = JSON.parse(readFileSync(join(ROOT, "docs/spec/events.json"), "utf8"));
  const emit = (name) => new Map([["packages/workbench-mygo/src/fixture.go", `package workbench\n\nfunc f(e *Events) {\n\te.Emit(sok.LevelInfo, "${name}", map[string]any{"started_at": 1, "url": "soksak://workbench"}, nil)\n}\n`]]);
  assert.deepEqual(emitFindings(catalog, emit("workbench.start"), "docs/spec/events.json", config).filter((line) => line.includes("fixture.go")), []);
  const refused = emitFindings(catalog, emit("workbench.undeclared"), "docs/spec/events.json", config);
  assert.ok(refused.some((line) => line.includes("fixture.go:4") && line.includes("workbench.undeclared")), refused.join("\n"));
});
