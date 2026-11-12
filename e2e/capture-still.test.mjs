// A still of an inactive window is written in the captures folder of the application. The still is evidence: the check judges
// where it is written, not what it shows.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { APPS, holdCovered, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { readStillCapture } from "./still-capture.mjs";
for (const app of Object.values(APPS))
  test(`${app.name}: the still of an inactive window is written in the captures folder`, { timeout: 120000 }, async (t) => {
    console.info(`START ${app.name}: still PNG observation`);
    const started = performance.now();
    const s = await open(t, app);
    t.diagnostic(`tested endpoint: ${JSON.stringify(s.client.endpoint)}`);
    const start = await fresh(s);
    // An inactive application shows its window behind the frontmost window, where its image regions do not draw. The still
    // reads the pixels of the window wherever it is in the window order (docs/spec/native-surfaces.md#image-regions).
    s.cleanup(await holdCovered(s));
    await s.run("core.settings.theme", { name: "midnight", mode: "dark" });
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === start.surface));
    assert.ok(card, "start card absent");
    const tab = card.tabs.find((tab) => tab.id === start.surface);
    await s.run("core.tab.select", { tab: tab.id });
    const set = (await s.get("core.settings")).values.sets.find((item) => item.sections.length);
    assert.ok(set, "section set absent");
    for (const side of ["left", "right"]) {
      await s.run("core.card.sidebar.set", { card: card.id, side, set: set.id });
      await s.run("core.card.sidebar.size", { card: card.id, side, size: 120 });
    }
    await s.presented();
    const before = await s.get("host.window");
    assert.equal(before.active, false);
    const surface = (await s.surfaces()).find((item) => item.surface === tab.id);
    assert.ok(surface?.applied, "native surface absent");
    const { path } = await readStillCapture(s, t);
    assert.ok(existsSync(path), `the still capture ${path} was not written`);
    // Every diagnostic file of an application is in <config-dir>/logs, captures in its captures folder (F124.2).
    const captures = join(realpathSync(app.configDir), "logs", "captures");
    assert.ok(realpathSync(path).startsWith(`${captures}/`), `the still capture ${path} is not in ${captures}`);
    const after = await s.get("host.window");
    assert.equal(after.active, false);
    console.info(`PASS ${app.name}: still PNG observation (${Math.round(performance.now() - started)}ms)`);
  });
