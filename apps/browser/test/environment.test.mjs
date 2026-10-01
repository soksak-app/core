import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { validateEnvironment } from "@soksak/plugin-api";

const environment = JSON.parse(readFileSync(new URL("../environment.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("environment.json satisfies the environment format and names a runtime module", () => {
  assert.equal(validateEnvironment(environment), environment);
  assert.ok(existsSync(new URL(`../${environment.runtime}/index.js`, import.meta.url)));
});

test("the environment lists no plugins; the configuration directory installs them", () => {
  assert.equal(environment.plugins, undefined);
  assert.deepEqual(Object.keys(pkg.dependencies).filter((name) => name.startsWith("@soksak/plugin-")), []);
});

test("the browser runtime runs no sidecars, so the environment says so", () => {
  assert.equal(environment.sidecars, false);
});
