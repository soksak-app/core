import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { INTERACTIVE, PAGE_IMPORTS, pageImports } from "@soksak/plugin-api";

const html = readFileSync(new URL("../ui/browser.html", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const { document } = new JSDOM(html).window;
const names = (kind) => manifest.exposes[kind].map((entry) => entry.name);

test("browser.html declares the page import map", () => {
  assert.deepEqual(pageImports(html), { ...PAGE_IMPORTS });
});

test("every control names a declared dom entry and a declared command", () => {
  const controls = [...document.querySelectorAll(INTERACTIVE)];
  assert.deepEqual(controls.map((el) => el.dataset.expose),
    ["browser.back", "browser.forward", "browser.reload", "browser.address"]);
  for (const el of controls) assert.ok(names("dom").includes(el.dataset.expose), el.dataset.expose);
  for (const el of document.querySelectorAll("[data-command]")) {
    assert.ok(names("commands").includes(el.dataset.command), el.dataset.command);
  }
});

test("the document region is a declared dom entry and the start address is home", () => {
  assert.ok(names("dom").includes(document.getElementById("document").dataset.expose));
  assert.match(manifest.home, /^https:\/\//);
  assert.deepEqual(names("commands"), ["browser.navigate", "browser.back", "browser.forward", "browser.reload", "browser.stop"]);
  assert.deepEqual(names("status"), ["browser.location"]);
});
