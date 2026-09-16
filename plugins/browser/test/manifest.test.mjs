import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { validateManifest } from "@soksak/plugin-api";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("plugin.json satisfies the manifest format", () => {
  assert.equal(validateManifest(manifest), manifest);
});

test("the package publishes the manifest and the surface page", () => {
  assert.ok(pkg.files.includes("plugin.json"));
  if (manifest.surface?.page === undefined) return;
  assert.ok(existsSync(new URL(`../${manifest.surface.page}`, import.meta.url)), manifest.surface.page);
  assert.ok(pkg.files.some((entry) => manifest.surface.page === entry || manifest.surface.page.startsWith(`${entry}/`)));
});
