import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { checkReferences, validateEnvironment, validateManifest } from "@soksak/plugin-api";

const require = createRequire(import.meta.url);
const environment = JSON.parse(readFileSync(new URL("../environment.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("environment.json satisfies the environment format and names a runtime module", () => {
  assert.equal(validateEnvironment(environment), environment);
  assert.ok(existsSync(new URL(`../${environment.runtime}/index.js`, import.meta.url)));
});

test("every plugin is a declared dependency and every reference resolves", () => {
  const manifests = environment.plugins.map((name) => {
    assert.ok(pkg.dependencies[name], `${name} is not a dependency`);
    return validateManifest(require(`${name}/plugin.json`));
  });
  checkReferences(environment, manifests);
});

test("the browser runtime runs no sidecars, so the environment says so", () => {
  assert.equal(environment.sidecars, false);
});
