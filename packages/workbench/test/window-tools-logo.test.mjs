// The SOKSAK logo is the first element of the window tool row on every screen, and it is the element core.chrome.projects, which runs
// core.projects.browse (docs/spec/external-sidebars.md#window-tools). The logo icon is the brand-logo icon that the workbench ships.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM(readFileSync(new URL("../index.html", import.meta.url), "utf8"), { url: "http://localhost/" });
const { document } = dom.window;

test("the SOKSAK logo is the first element of the window tool row and carries core.chrome.projects", () => {
  const row = document.querySelector(".chrome-bar");
  const first = row.querySelector(":scope > [data-expose]:not(.chrome-bar__drag)");
  assert.equal(first?.dataset.expose, "core.chrome.projects", "the first element of the row is not the logo");
  assert.ok(first.querySelector("svg.brand__logo"), "the logo carries no brand-logo icon");
  assert.equal(document.querySelector('[data-expose="core.brand"]'), null, "the logo still carries the obsolete name core.brand");
});
