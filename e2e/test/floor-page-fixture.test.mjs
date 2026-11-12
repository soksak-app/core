import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkViewPage, validateManifest } from "@soksak/plugin-api";
import { FLOOR_COLOUR, FLOOR_PAGE, openFloorPage, writeDragLayouts } from "../benchmark/cases/floor-page.mjs";

const read = (path) => readFileSync(join(FLOOR_PAGE.folder, path), "utf8");

test("the floor page is a view whose page draws the measurement colour and runs no code but the declaration of its composition", { timeout: 5000 }, () => {
  const manifest = JSON.parse(read("plugin.json"));
  validateManifest(manifest);
  assert.equal(manifest.id, FLOOR_PAGE.plugin);
  assert.deepEqual(manifest.surface, { composition: { kind: "view", page: "ui/page.html" } });
  assert.equal(manifest.exposes, undefined);
  const page = read("ui/page.html");
  checkViewPage(page);
  assert.deepEqual([...page.matchAll(/<script\b[^>]*>/g)].map(([tag]) => tag), ['<script type="module" src="./start.js">']);
  assert.match(page, new RegExp(`background:\\s*rgb\\(${FLOOR_COLOUR.join(",\\s*")}\\)`));
  const start = read("ui/start.js");
  assert.deepEqual([...start.matchAll(/^import .* from "([^"]+)";$/gm)].map(([, from]) => from), ["@soksak/plugin-api/view"]);
  assert.match(start, /^await bridge\.composition\.create\(\);$/m);
});

test("the floor page opens as the active tab of the focused card, which a fixture configuration has installed, and its cleanup closes it", { timeout: 5000 }, async () => {
  const calls = [];
  const cleanups = [];
  const grid = { cards: [{ id: "c1", focused: false, active: "s1" }, { id: "c2", focused: true, active: "s9" }] };
  const s = {
    cleanup: (fn) => { cleanups.push(fn); },
    get: async (name) => {
      calls.push(`get ${name}`);
      return grid;
    },
    run: async (name, params) => {
      calls.push(`run ${name} ${JSON.stringify(params)}`);
      return name === "core.card.add-tab" ? { tab: "s9" } : null;
    },
    until: async (name, predicate, message) => {
      const value = { "core.grid": grid, "core.surfaces": [{ surface: "s9", status: { phase: "ready" } }] }[name];
      assert.ok(predicate(value), message);
      calls.push(`until ${name}`);
      return value;
    },
  };
  assert.deepEqual(await openFloorPage(s), { surface: "s9", card: "c2" });
  assert.deepEqual(calls, [
    "get core.grid",
    'run core.card.add-tab {"card":"c2","plugin":"floorpage"}',
    "until core.grid",
    "until core.surfaces",
  ]);
  calls.length = 0;
  for (const cleanup of cleanups.toReversed()) await cleanup();
  assert.deepEqual(calls, ['run core.tab.close {"tab":"s9"}']);
  grid.cards[1].focused = false;
  await assert.rejects(openFloorPage(s), new Error("the start layout has no focused card for the floor page"));
});

test("drag layout evidence is written before frame analysis", { timeout: 5000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "drag-layouts-"));
  try {
    const layouts = [{ ticket: 4, begun: 10, presented: 26, committed: 30 }];
    const path = writeDragLayouts(directory, layouts);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { layouts });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
