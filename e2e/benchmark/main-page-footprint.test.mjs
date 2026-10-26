import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadavg } from "node:os";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { tailOf } from "../chains.mjs";
import { closeAddedMainPageWindows, readMainPageFootprint } from "./cases/main-page-footprint.mjs";

async function mainPageFact(session) {
  const status = await session.until("host.window", (value) => Number.isSafeInteger(value.pageProcess) && value.pageProcess > 0,
    `${session.window}: the main page has no WebContent process`);
  return { window: session.window, pageProcess: status.pageProcess };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: one and two main-page process footprints are measured`, { timeout: 90000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { performanceTrace: true, log: { call: "debug" }, reads: ["host.sampler.memory"] });
    await s.windows(1, "the benchmark did not start with one window");
    const baselineWindows = await s.get("host.windows");
    assert.equal(baselineWindows.length, 1, "the benchmark baseline must contain one window");
    const baselineIdentities = baselineWindows.map((row) => row.window);
    s.cleanup(() => closeAddedMainPageWindows(s, baselineWindows));

    const operationErrors = [];
    let oneWindow;
    let twoWindows;
    try {
      const initialPage = await mainPageFact(s);
      const oneWindowSince = await tailOf(s);
      oneWindow = await readMainPageFootprint(s, [initialPage], oneWindowSince, loadavg);

      await s.run("core.window.new");
      const openedWindows = await s.windows(2, "the second benchmark window did not become ready");
      const secondIdentity = openedWindows.find((row) => !baselineIdentities.includes(row.window))?.window;
      assert.ok(secondIdentity, `no new window appeared: ${JSON.stringify(openedWindows)}`);
      const child = s.on(secondIdentity);
      await child.presented();

      const pages = [await mainPageFact(s), await mainPageFact(child)];
      assert.equal(new Set(pages.map((row) => row.window)).size, 2, "the page snapshot does not cover two distinct windows");
      const twoWindowSince = await tailOf(s);
      const baselinePage = oneWindow.windows.map(({ window, pageProcess }) => ({ window, pageProcess }));
      twoWindows = await readMainPageFootprint(s, pages, twoWindowSince, loadavg, baselinePage);

      const afterSample = [await mainPageFact(s), await mainPageFact(child)];
      assert.deepEqual(afterSample, pages, "a main page process changed while its sampler footprint was measured");
      const evidence = { host: app.name, baselineWindowIdentities: baselineIdentities,
        oneWindow, twoWindows };
      const directory = join(app.configDir, "logs", "main-page-footprint");
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `${process.pid}.json`);
      writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
      t.diagnostic(`main-page footprint evidence ${path}`);
      t.diagnostic(`${app.name}: one window ${oneWindow.uniqueProcessCount} unique page process(es), ` +
        `${oneWindow.totalFootprintKB} KB; two windows ${twoWindows.windowCount} window(s), ` +
        `${twoWindows.uniqueProcessCount} unique page process(es), ${twoWindows.totalFootprintKB} KB; ` +
        `load averages ${JSON.stringify({ oneWindow: oneWindow.loadAverage, twoWindows: twoWindows.loadAverage })}`);
      assert.equal(oneWindow.windowCount, 1);
      assert.equal(twoWindows.windowCount, 2);
      assert.equal(twoWindows.windows.length, 2);
      assert.equal(twoWindows.uniqueProcessCount, twoWindows.uniqueProcesses.length);
      assert.ok(twoWindows.totalFootprintKB > 0, "the two-window main-page footprint is not positive");
    } catch (error) {
      operationErrors.push(error);
    }

    try {
      await closeAddedMainPageWindows(s, baselineWindows);
    } catch (error) {
      operationErrors.push(error);
    }
    if (operationErrors.length === 1) throw operationErrors[0];
    if (operationErrors.length > 1) {
      throw new AggregateError(operationErrors, `${app.name}: main-page footprint measurement and cleanup failed`,
        { cause: operationErrors[0] });
    }
  });
}
