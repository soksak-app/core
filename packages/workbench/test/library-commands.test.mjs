// Each pressable element of the library runs its command with the parameters that the declaration of the command requires
// (docs/spec/exposure.md): a press of an element without them fails the command before it runs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";
import exposureFile from "../exposure.json" with { type: "json" };

selectPageWire("overlay-none");
const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const dom = new JSDOM(markup, { url: "http://localhost/" });
dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.CSS = dom.window.CSS;
const { installExposure } = await import("../exposure.js");
const { createLibrary } = await import("../library.js");
installExposure(exposureFile);

// The members that the declaration of each command requires.
const required = new Map();
(function walk(value) {
  if (Array.isArray(value)) value.forEach(walk);
  else if (value !== null && typeof value === "object") {
    if (typeof value.name === "string" && value.params?.required) required.set(value.name, value.params.required);
    Object.values(value).forEach(walk);
  }
})(exposureFile);

test("each pressable element of the library carries the parameters that its command requires", () => {
  const root = document.createElement("div");
  document.body.append(root);
  const library = createLibrary(root);
  library.render();
  library.actions.openForm("create");
  const missing = [];
  for (const element of root.querySelectorAll("[data-command]")) {
    // An input, a select and a text area give their value as a parameter when they change.
    if (element.matches("input, select, textarea")) continue;
    const params = element.dataset.params === undefined ? {} : JSON.parse(element.dataset.params);
    for (const member of required.get(element.dataset.command) ?? []) {
      if (!(member in params)) missing.push(`${element.dataset.expose ?? element.className}: ${element.dataset.command} misses ${member}`);
    }
  }
  assert.ok(root.querySelector('[data-expose="core.library.add"]'), "the library has no add button");
  assert.deepEqual(missing, []);
});
