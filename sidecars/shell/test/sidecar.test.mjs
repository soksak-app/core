import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateSidecar } from "@soksak/plugin-api";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

test("sidecar.json satisfies the sidecar format and the package publishes its executable", () => {
  const sidecar = validateSidecar(read("sidecar.json"));
  const pkg = read("package.json");
  assert.ok(pkg.files.includes("sidecar.json"));
  assert.ok(pkg.files.includes(sidecar.executable));
  assert.match(pkg.scripts.build, new RegExp(`-o ${sidecar.executable} `));
});
