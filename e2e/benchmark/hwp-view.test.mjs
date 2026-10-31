import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { evaluateReclaim, runViewMeasurements } from "@soksak/window-check/view-metrics.mjs";
import { fresh } from "../fixture.mjs";
import { openRecordedView, viewCardWithDifferentPluginTab } from "../view-metrics-collection.mjs";
import { collectHwpReclaimAfterMotion, collectHwpViewMeasurements, hwpViewDescriptor,
  HWP_VIEW_BASELINES_MS } from "./cases/hwp.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: HWP process, history, layout, and drag measurements meet the declared contract`,
    { timeout: 240000 }, async (t) => {
      const s = await open(t, app);
      await fresh(s, {
        performanceTrace: true,
        log: { frame: "trace" },
        reads: [
          "host.trace.view.process-request",
          "host.trace.view.process-ready",
          "plugin.hwp.view.content_frame",
        ],
      });
      const result = await runViewMeasurements(t, s, {
        plugin: "hwp",
        baselinesMs: HWP_VIEW_BASELINES_MS,
        collect: async () => collectHwpViewMeasurements(t, s, { baselineMs: HWP_VIEW_BASELINES_MS[app.name] }),
      });
      const directory = join(app.configDir, "logs", "hwp-view-metrics");
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `${process.pid}.json`);
      writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
      t.diagnostic(`HWP view measurement evidence ${path}`);
      assert.equal(result.evaluation.plugin, "hwp");
      assert.equal(result.evaluation.host, app.name);
    });

  test(`${app.name}: HWP reclaim restores the declared card width before three reclaim runs`,
    { timeout: 120000 }, async (t) => {
      const s = await open(t, app);
      await fresh(s, {
        performanceTrace: true,
        log: { frame: "trace" },
        reads: [
          "host.trace.view.process-request",
          "host.trace.view.process-ready",
          "plugin.hwp.view.content_frame",
        ],
      });
      const descriptor = await hwpViewDescriptor(s, (message) => t.diagnostic(message),
        HWP_VIEW_BASELINES_MS[app.name] + 300);
      const grid = await s.get("core.grid");
      const activeCard = grid.cards.find((item) => item.active);
      const card = viewCardWithDifferentPluginTab(grid, descriptor.plugin, activeCard?.id);
      await s.run("core.grid.size", { card, axis: "x", size: 760 });
      await s.presented();
      const initialGrid = await s.get("core.grid");
      const initialCard = initialGrid.cards.find((item) => item.id === card);
      // core.grid.size redistributes the available plane width, so retain the reported geometry instead of assuming the request is exact.
      assert.ok(Number.isFinite(initialCard?.w) && initialCard.w > 0 && initialCard.w < 767,
        `HWP reclaim fixture did not establish a compact ${card} width: ${JSON.stringify(initialCard?.w)}`);
      const opened = await openRecordedView(t, s, { card, ...descriptor });
      const start = { card, initialCardWidth: initialCard.w, opened: [opened],
        warmDisplay: { surface: opened.surface } };
      const expandedWidth = initialCard.w + 80;
      await s.run("core.grid.size", { card, axis: "x", size: expandedWidth });
      await s.presented();
      const expandedGrid = await s.get("core.grid");
      const expandedCard = expandedGrid.cards.find((item) => item.id === card);
      assert.ok(Number.isFinite(expandedCard?.w) && expandedCard.w > 767 && expandedCard.w > initialCard.w,
        `HWP reclaim fixture did not cross the responsive-width boundary: ${JSON.stringify(expandedCard?.w)}`);
      const evidence = { events: [...opened.events], recordings: [opened.recording] };
      const reclaim = await collectHwpReclaimAfterMotion(t, s, descriptor, start, evidence);
      const reclaimEvaluation = evaluateReclaim(reclaim);
      assert.equal(reclaim.length, 3, "HWP reclaim did not return all three process-group runs");
      for (const [index, run] of reclaim.entries()) {
        assert.ok(run.closedViews.length > 0, `HWP reclaim run ${index + 1} omitted closed history evidence`);
        assert.ok(run.closedViews.every((view) => view.rootHistoryEntries === 1
          && view.documents.every((document) => document.historyEntries === 1)),
        `HWP reclaim run ${index + 1} omitted initial-only history evidence`);
        t.diagnostic(`HWP reclaim run ${index + 1}: ${JSON.stringify({
          evaluation: reclaimEvaluation[index], elapsedMs: run.elapsedMs,
          engineCacheHeld: run.engineCacheHeld, closedViews: run.closedViews })}`);
      }
      const restoredGrid = await s.get("core.grid");
      const restoredCard = restoredGrid.cards.find((item) => item.id === card);
      assert.ok(Number.isFinite(restoredCard?.w) && Math.abs(restoredCard.w - initialCard.w) <= 2
        && restoredCard.w < 767,
      `HWP reclaim did not restore the compact card width within 2 pt: ${JSON.stringify({
        initial: initialCard.w, restored: restoredCard?.w,
      })}`);
    });
}
