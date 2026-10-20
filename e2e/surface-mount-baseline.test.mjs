// Measures the DOM mount time of every surface plugin that the add menu of a card offers. Each plugin opens three times in a
// card; the page writes page.trace.surface.mount (plugin, surface, ms) when the module mount of the surface completes, and the
// check reads those records and reports the median of the three runs of each plugin (docs/spec/performance-trace.md).
import assert from "node:assert/strict";
import { copyFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents, traceRows, untilEventLines } from "@soksak/window-check/event-log.mjs";
import { fresh, reading } from "./fixture.mjs";

const RUNS = 3;
// The limit of one open: from the add of the tab until its mount record is in the event log.
const MOUNT_TIMEOUT = 30000;
// The limit of the runs of one plugin, which covers its three opens and their closes.
const PLUGIN_TIMEOUT = 180000;
const HWP_FIXTURE = fileURLToPath(new URL("./fixtures/two-paragraphs.hwp", import.meta.url));

// The plugins that take a file of the project in params.path, with the file that each one opens. The file is created in the
// project root before the first open and removed when the check ends.
const FILE_PLUGINS = {
  editor: { file: (pid) => `mount-baseline-${pid}.txt`, create: (path) => writeFileSync(path, "mount baseline\n") },
  hwp: { file: (pid) => `mount-baseline-${pid}.hwp`, create: (path) => copyFileSync(HWP_FIXTURE, path) },
};

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const loads = () => loadavg().map((value) => value.toFixed(2)).join(" ");

/** The plugin ids of the add menu of the card. The menu lists the registered plugins, which are the plugins with surfaces. */
async function addMenuPlugins(s, card) {
  await s.run("core.card.menu", { card, menu: "add" });
  const picker = await s.until("core.picker", (value) => value.open, "the add menu of the card did not open");
  const plugins = picker.items.map((item) => item.key);
  await s.run("core.picker.close");
  await s.until("core.picker", (value) => !value.open, "the add menu did not close");
  return plugins;
}

/** Closes the tab when the grid still holds it, so a close after a failed open does not fail again. */
async function closeTab(s, tab) {
  const grid = await s.get("core.grid");
  if (!grid.cards.some((card) => (card.tabs ?? []).some((item) => item.id === tab))) return;
  const result = await s.run("core.tab.close", { tab });
  if (result?.closed !== true) throw new Error(`core.tab.close did not close ${tab}: ${JSON.stringify(result)}`);
}

/** Opens the plugin in the card, waits for its mount record, closes its tab, and returns the ms of the record. */
async function mountMs(s, app, card, plugin, params) {
  const before = currentEventOffsets(app.configDir);
  const known = new Set((await s.get("core.surfaces")).map((item) => item.surface));
  const { tab } = await s.run("core.card.add-tab", { card, plugin, params });
  s.cleanup(() => closeTab(s, tab));
  let surface;
  try {
    // The surface of this open is the visible surface of the plugin that was not registered before the open.
    const isNew = (item) => item.visible && item.plugin === plugin && !known.has(item.surface);
    const appeared = await s.until("core.surfaces", (all) => all.some(isNew), "the surface did not appear");
    surface = appeared.find(isNew).surface;
    await untilEventLines(app.configDir, before,
      (lines) => lines.some((line) => line.includes("page.trace.surface.mount: ") && line.includes(`"plugin":${JSON.stringify(plugin)}`)),
      MOUNT_TIMEOUT, reading(app, ["page.trace.surface.mount"]));
  } catch (error) {
    throw new Error(`plugin ${plugin} did not mount its surface: ${error.message}`, { cause: error });
  }
  await s.flushLog();
  const rows = traceRows(readEvents(app.configDir, before).events)
    .filter((row) => row.event === "surface.mount" && row.plugin === plugin);
  if (rows.length !== 1) throw new Error(`plugin ${plugin}: expected one surface.mount record after its open, found ${rows.length}`);
  const ms = rows[0].ms;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) throw new Error(`plugin ${plugin}: invalid ms ${JSON.stringify(ms)}`);
  await closeTab(s, tab);
  await s.until("core.surfaces", (all) => !all.some((item) => item.surface === surface),
    `plugin ${plugin}: surface ${surface} did not close`);
  return ms;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the DOM mount time of every surface plugin of the add menu`, { timeout: 900000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    t.diagnostic(`load average at start ${loads()}`);
    await fresh(s, { performanceTrace: true, reads: ["page.trace.surface.mount"] });
    const card = (await s.get("core.grid")).cards.find((item) => item.pane !== null && item.acts?.add?.enabled);
    if (!card) throw new Error(`${app.name}: no pane card has an enabled add menu`);
    const plugins = await addMenuPlugins(s, card.id);
    if (plugins.length === 0) throw new Error(`${app.name}: the add menu lists no surface plugin`);
    t.diagnostic(`${app.name}: surface plugins ${plugins.join(", ")}`);
    const project = await s.get("core.project");
    for (const [plugin, { file, create }] of Object.entries(FILE_PLUGINS)) {
      if (!plugins.includes(plugin)) continue;
      const path = join(project.root, file(process.pid));
      create(path);
      s.cleanup(() => rmSync(path, { force: true }));
    }
    const medians = [];
    for (const plugin of plugins) {
      await t.test(`${plugin}: ${RUNS} mounts`, { timeout: PLUGIN_TIMEOUT }, async (u) => {
        const params = FILE_PLUGINS[plugin] ? { path: FILE_PLUGINS[plugin].file(process.pid) } : undefined;
        const values = [];
        for (let run = 1; run <= RUNS; run++) {
          values.push(await mountMs(s, app, card.id, plugin, params));
          u.diagnostic(`${app.name} ${plugin} run ${run}: ${values.at(-1).toFixed(1)} ms`);
        }
        const value = median(values);
        medians.push({ plugin, value });
        u.diagnostic(`${app.name} ${plugin} median: ${value.toFixed(1)} ms of ${values.map((ms) => ms.toFixed(1)).join(", ")}`);
      });
    }
    t.diagnostic(`load average at end ${loads()}`);
    for (const { plugin, value } of medians) t.diagnostic(`${app.name} baseline ${plugin}: ${value.toFixed(1)} ms`);
  });
}
