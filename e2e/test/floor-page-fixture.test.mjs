import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("a fixture registry is a new folder that the fixture registry build writes under the signal, and a failed build removes it", { timeout: 5000 }, async (t) => {
  const builds = [];
  const signal = new AbortController().signal;
  const folder = await fixtureRegistry({ sok: "/bin/sok", signal, build: async (sok, out, options) => {
    builds.push([sok, out, options]);
    writeFileSync(join(out, "index.json"), "{}");
  } });
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  assert.deepEqual(builds, [["/bin/sok", folder, { signal }]]);
  assert.equal(readFileSync(join(folder, "index.json"), "utf8"), "{}");
  let failed;
  await assert.rejects(fixtureRegistry({ sok: "/bin/sok", build: async (_, out) => { failed = out; throw new Error("registry build failed"); } }),
    /registry build failed/);
  assert.equal(existsSync(failed), false);
});

test("a failed fixture registry build whose folder cannot be removed rejects with both failures", { timeout: 5000 }, async (t) => {
  let folder;
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  await assert.rejects(fixtureRegistry({
    sok: "/bin/sok",
    build: async (_, out) => { folder = out; throw new Error("registry build failed"); },
    remove: () => { throw new Error("folder removal failed"); },
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((item) => item.message), ["registry build failed", "folder removal failed"]);
    return true;
  });
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
    registry: async () => "/tmp/floor-registry",
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
