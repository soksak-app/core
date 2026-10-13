import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";

function processes(appName) {
  return execFileSync("ps", ["-axo", "pid=,rss=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, rss, command]) => ({ pid: Number(pid), rss: Number(rss), command }));
}

function memory(appName) {
  const rows = processes(appName);
  return { host: rows.find((row) => row.command.includes(`soksak-${appName}.app/Contents/MacOS/`))?.rss };
}

/**
 * List of the web documents that the window holds. If a split and a reload leave documents, document regions and image regions, the list grows. The memory of the page process
 * is not judged because WebKit keeps the previous reloaded document until memory pressure (docs/operations/private-native-apis.md).
 */
function inventory(window) {
  return JSON.stringify({ webviews: window.webviews.length, surfaces: window.surfaces.map((surface) => surface.id).sort(),
    documents: window.documents.length, regions: window.regions.length });
}

function gridCards(grid) {
  return grid.cards.filter((card) => card.pane !== null);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: split, resize, reload, and WebView churn stay bounded`, { timeout: 300_000 }, async (t) => {
    const session = await open(t, app);
    if (!session) return t.skip(`${app.binary} is not built`);
    await fresh(session);
    const initialWindow = await session.get("host.window");
    const initialGrid = await session.get("core.grid");
    const baseline = memory(app.name);
    assert.ok(Number.isInteger(baseline.host), "host RSS was not measurable before stress");
    const before = inventory(initialWindow);
    const samples = [baseline];
    const created = [];

    session.cleanup(async () => {
      for (const card of [...created].reverse()) {
        const grid = await session.get("core.grid");
        if (gridCards(grid).some((entry) => entry.id === card)) {
          await session.run("core.card.close", { card });
          await session.until("core.grid", (next) => !next.cards.some((entry) => entry.id === card),
            `stress cleanup did not close ${card}`);
        }
      }
      await session.run("host.window.resize", {
        width: initialWindow.content.width,
        height: initialWindow.content.height,
      });
      await session.presented();
      const restored = await session.get("core.grid");
      assert.deepEqual(gridCards(restored).map((card) => card.id).sort(),
        gridCards(initialGrid).map((card) => card.id).sort(), "stress cleanup did not restore the card set");
    });

    for (let round = 0; round < 32; round++) {
      const before = await session.get("core.grid");
      const source = gridCards(before).find((card) => card.id === "terminal") ?? gridCards(before)[0];
      assert.ok(source, "stress layout has no source card");
      await session.run("core.card.focus", { card: source.id });
      await session.until("core.grid", (grid) => grid.cards.find((card) => card.id === source.id)?.focused === true,
        `stress source card ${source.id} did not focus`);
      const result = await session.run("core.card.split", { card: source.id, side: "right", plugin: "browser" });
      const made = [result.card];
      created.push(result.card);
      await session.until("core.grid", (grid) => grid.cards.some((card) => card.id === result.card),
        `split ${result.card} did not appear`);
      const width = round % 2 === 0 ? Math.max(640, initialWindow.content.width - 240) : initialWindow.content.width + 160;
      await session.run("host.window.resize", { width, height: initialWindow.content.height });
      await session.until("host.window", (window) => window.content.width === width,
        `stress resize did not reach ${width}`);
      await session.presented();
      for (let reload = 0; reload < 3; reload++) {
        await session.run("host.window.reload");
        await session.presented();
      }
      samples.push(memory(app.name));
      for (const card of made.reverse()) {
        await session.run("core.card.close", { card });
        await session.until("core.grid", (grid) => !grid.cards.some((entry) => entry.id === card),
          `stress close did not remove ${card}`);
      }
      await session.presented();
      samples.push(memory(app.name));
    }

    const measured = samples.filter((sample) => Number.isInteger(sample.host));
    assert.equal(measured.length, samples.length, "stress produced an unmeasurable host RSS sample");
    const maxHost = Math.max(...measured.map((sample) => sample.host));
    // All created cards were closed, so the window holds the same documents as at the start.
    const settled = await session.until("host.window", (window) => inventory(window) === before,
      `the window documents differ from ${before} after the stress`);
    t.diagnostic(`split-load-memory ${JSON.stringify({ app: app.name, samples: samples.length,
      baselineHost: baseline.host, maxHost, hostGrowth: maxHost - baseline.host, documents: before })}`);
    // A reload opens the new document in a new page process and ends the previous process (docs/spec/native-host.md#page-reload).
    assert.notEqual(settled.pageProcess, initialWindow.pageProcess, "the reloads kept the page process");
    await session.request("diagnostics.process.exit", { pid: initialWindow.pageProcess }).catch((error) => {
      throw new Error(`the reloads left the first page process ${initialWindow.pageProcess} running: ${error.message}`);
    });
    assert.ok(maxHost - baseline.host < 128 * 1024,
      `host RSS grew ${maxHost - baseline.host} KB during split/WebView stress`);
  });
}
