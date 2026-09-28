import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";

function processes(appName) {
  return execFileSync("ps", ["-axo", "pid=,rss=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, rss, command]) => ({ pid: Number(pid), rss: Number(rss), command }));
}

function memory(appName) {
  const rows = processes(appName);
  return {
    host: rows.find((row) => row.command.includes(`soksak-${appName}.app/Contents/MacOS/`))?.rss,
    webContent: rows.filter((row) => row.command.includes("com.apple.WebKit.WebContent")),
  };
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
    assert.ok(baseline.webContent.length > 0, "WebContent process was not measurable before stress");
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
      const source = gridCards(before).find((card) => card.id === "shell") ?? gridCards(before)[0];
      assert.ok(source, "stress layout has no source card");
      await session.run("core.card.focus", { card: source.id });
      await session.until("core.grid", (grid) => grid.cards.find((card) => card.id === source.id)?.focused === true,
        `stress source card ${source.id} did not focus`);
      const result = await session.run("core.card.split", { card: source.id, axis: "x", plugin: "browser" });
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
    const maxWebContent = Math.max(...measured.flatMap((sample) => sample.webContent.map((row) => row.rss)));
    const maxWebContentCount = Math.max(...measured.map((sample) => sample.webContent.length));
    const baselineWeb = Math.max(...baseline.webContent.map((row) => row.rss));
    t.diagnostic(`split-load-memory ${JSON.stringify({ app: app.name, samples: samples.length,
      baselineHost: baseline.host, maxHost, baselineWeb, maxWebContent, maxWebContentCount,
      hostGrowth: maxHost - baseline.host, webContentGrowth: maxWebContent - baselineWeb })}`);
    assert.ok(maxHost - baseline.host < 128 * 1024,
      `host RSS grew ${maxHost - baseline.host} KB during split/WebView stress`);
    assert.ok(maxWebContent - baselineWeb < 256 * 1024,
      `WebContent RSS grew ${maxWebContent - baselineWeb} KB during split/WebView stress`);
    assert.ok(maxWebContentCount <= baseline.webContent.length + 4,
      `WebContent process count grew from ${baseline.webContent.length} to ${maxWebContentCount}`);
  });
}
