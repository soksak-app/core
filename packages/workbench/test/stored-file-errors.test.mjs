// Checks that the page lists the errors of the refused stored files of a workspace snapshot, so it shows each of them and
// starts (docs/spec/projects.md#settings).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { storedFileErrors } from "../host-store.js";

test("a snapshot lists the error of a refused projects.json and of a refused settings.json", { timeout: 1000 }, () => {
  assert.deepEqual(storedFileErrors({ projects: [], common: {} }), []);
  assert.deepEqual(storedFileErrors({ projects: [], common: {}, projectsError: "p: projects.json: format must be 1" }),
    ["p: projects.json: format must be 1"]);
  assert.deepEqual(storedFileErrors({ projects: [], common: {}, projectsError: "p: bad", settingsError: "s: settings.json: format must be 1" }),
    ["p: bad", "s: settings.json: format must be 1"]);
});

test("the start document shows the errors of the refused stored files before the page draws", { timeout: 1000 }, () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /for \(const text of storedFileErrors\(start\.workspace\)\) showError\(text\);/);
});
