import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkViewPage, validateManifest } from "@soksak/plugin-api";
import { FLOOR_PAGE, fixtureRegistry, openFloorPage } from "../benchmark/cases/floor-page.mjs";
import { TERMINAL_GEOMETRY_BACKGROUND } from "../benchmark/cases/terminal.mjs";

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
  assert.match(page, new RegExp(`background:\\s*rgb\\(${TERMINAL_GEOMETRY_BACKGROUND.join(",\\s*")}\\)`));
  const start = read("ui/start.js");
  assert.deepEqual([...start.matchAll(/^import .* from "([^"]+)";$/gm)].map(([, from]) => from), ["@soksak/plugin-api/view"]);
  assert.match(start, /^await bridge\.composition\.create\(\);$/m);
});

test("a fixture registry holds the workspace registry and the packed fixture plugin, and its index is built", { timeout: 5000 }, (t) => {
  const registry = mkdtempSync(join(tmpdir(), "fixture-registry-source-"));
  t.after(() => rmSync(registry, { recursive: true, force: true }));
  for (const name of ["plugins", "sidecars", "packs"]) mkdirSync(join(registry, name));
  writeFileSync(join(registry, "revoked.json"), "[]");
  writeFileSync(join(registry, "plugins", "term.json"), "{}");
  writeFileSync(join(registry, "sidecars", "files.json"), JSON.stringify({ name: "files" }));
  const runs = [];
  const folder = fixtureRegistry({
    sok: "/bin/sok", registry, plugin: FLOOR_PAGE.folder,
    pack: (dir, out) => { assert.equal(dir, FLOOR_PAGE.folder); return { release: join(out, "floor.tgz"), sha256: "ab" }; },
    run: (command, args) => { runs.push([command, ...args]); },
  });
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  assert.deepEqual(runs, [["/bin/sok", "registry", "build", folder]]);
  const entry = JSON.parse(readFileSync(join(folder, "plugins", `${FLOOR_PAGE.plugin}.json`), "utf8"));
  assert.equal(entry.id, FLOOR_PAGE.plugin);
  assert.deepEqual(entry.versions[0].sidecars, {});
  assert.equal(entry.versions[0].release.sha256, "ab");
  assert.equal(readFileSync(join(folder, "plugins", "term.json"), "utf8"), "{}");
  assert.equal(readFileSync(join(folder, "revoked.json"), "utf8"), "[]");
});

test("the floor page opens as the active tab of the terminal card from its registry, and the cleanup removes it in reverse", { timeout: 5000 }, async () => {
  const calls = [];
  const cleanups = [];
  let installed = false;
  const s = {
    cleanup: (fn) => { cleanups.push(fn); },
    get: async (name) => {
      calls.push(`get ${name}`);
      return { registry: "file:///registry/index.json", plugins: [{ id: FLOOR_PAGE.plugin, installed }] };
    },
    run: async (name, params) => {
      calls.push(`run ${name} ${JSON.stringify(params)}`);
      if (name === "core.plugins.install") installed = true;
      if (name === "core.plugins.remove") installed = false;
      return name === "core.card.add-tab" ? { tab: "s9" } : null;
    },
    until: async (name, predicate, message) => {
      const value = {
        "core.plugins": { plugins: [{ id: FLOOR_PAGE.plugin, installed }] },
        "core.grid": { cards: [{ id: "terminal", active: "s9" }] },
        "core.surfaces": [{ surface: "s9", status: { phase: "ready" } }],
      }[name];
      assert.ok(predicate(value), message);
      calls.push(`until ${name}`);
      return value;
    },
  };
  const tab = await openFloorPage(s, {
    registry: () => "/tmp/floor-registry",
    applied: async (_, run, action) => { await run(); calls.push(`applied ${action}`); },
    remove: (folder) => calls.push(`rm ${folder}`),
  });
  assert.equal(tab, "s9");
  assert.deepEqual(calls, [
    "get core.plugins",
    'run core.plugins.registry {"index":"file:///tmp/floor-registry/index.json"}',
    "until core.plugins",
    'run core.plugins.install {"plugin":"floorpage"}',
    "applied the install of floorpage",
    'run core.card.add-tab {"card":"terminal","plugin":"floorpage"}',
    "until core.grid",
    "until core.surfaces",
  ]);
  calls.length = 0;
  for (const cleanup of cleanups.toReversed()) await cleanup();
  assert.deepEqual(calls, [
    'run core.tab.close {"tab":"s9"}',
    "get core.plugins",
    'run core.plugins.remove {"plugin":"floorpage"}',
    "applied the removal of floorpage in the cleanup",
    'run core.plugins.registry {"index":"file:///registry/index.json"}',
    "rm /tmp/floor-registry",
  ]);
});
