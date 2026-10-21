// Tests of the module exports of scripts/check-boundaries.mjs. Importing the module runs no check and prints nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkNames, components } from "../check-boundaries.mjs";

// The names are joined from parts: the boundary audit scans this file for @soksak/ names.
const scoped = (name) => ["@soksak", name].join("/");
const core = new Set([scoped("plugin-api"), scoped("workbench")]);

test("importing the boundary module runs no check", (t) => {
  // The probe is a file, so that process.argv[1] names it, as the entry guard of the imported modules expects.
  const dir = mkdtempSync(join(tmpdir(), "soksak-boundaries-import-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = join(dir, "probe.mjs");
  const script = fileURLToPath(new URL("../check-boundaries.mjs", import.meta.url));
  writeFileSync(probe, `import ${JSON.stringify(pathToFileURL(script).href)};\n`);
  const result = spawnSync(process.execPath, [probe], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("components lists the core packages and the declared folders", () => {
  const found = components();
  assert.ok(found.some((item) => item.kind === "core" && item.name === scoped("plugin-api")));
  assert.ok(found.every((item) => typeof item.name === "string"));
});

test("checkNames allows the exact core names and refuses the others", () => {
  const files = ["packages/x/a.js", "packages/x/b.ts"];
  const source = {
    "packages/x/a.js": `import "${scoped("plugin-api")}";\nimport "${scoped("plugin-api")}/view";\n`,
    "packages/x/b.ts": `import "${scoped("plugin-api-x")}";\n`,
  };
  const errors = checkNames(core, files, (file) => source[file]);
  assert.deepEqual(errors, [
    `packages/x/b.ts:1: core source names ${scoped("plugin-api")}-x, which is not a core package`,
  ]);
});

test("checkNames reports a file it cannot read", () => {
  const errors = checkNames(core, ["packages/x/missing.js"], () => {
    throw new Error("gone");
  });
  assert.deepEqual(errors, ["packages/x/missing.js: cannot be read: gone"]);
});
