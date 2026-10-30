// Checks that each view page of the window-check fixture plugins has the form that the native view handler loads
// (docs/spec/native-surfaces.md#view-surfaces): a doctype at its start and no import map of its own, because the handler
// inserts the view import map after the doctype.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** The plugin.json files under folder. */
function manifests(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return manifests(path);
    return entry.name === "plugin.json" ? [path] : [];
  });
}

test("each view page of the fixture plugins starts with a doctype and holds no import map", { timeout: 5000 }, () => {
  const pages = manifests(FIXTURES).flatMap((path) => {
    const composition = JSON.parse(readFileSync(path, "utf8")).surface?.composition;
    return composition?.kind === "view" ? [join(dirname(path), composition.page)] : [];
  });
  assert.ok(pages.length > 0, "no fixture plugin declares a view page");
  for (const page of pages) {
    const html = readFileSync(page, "utf8");
    assert.match(html, /^<!doctype[^>]*>/i, `${page} has no doctype at its start`);
    assert.doesNotMatch(html, /<script\b[^>]*\btype\s*=\s*["']?importmap\b/i, `${page} has an import map`);
  }
});
