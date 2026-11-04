// Measures the floor of a view drag: the same width drag and recording as the plugin view benchmarks, on a view without plugin code. It reports
// the in-gesture source intervals and judges only that the recording covers the gesture, because the floor is an input of the targets.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { APPS, drag, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets } from "@soksak/window-check/event-log.mjs";
import { pluginEntry, pnpmPack } from "../../scripts/workspace-registry.mjs";
import { fresh, pluginChangeApplied } from "../fixture.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { mapViewContentFramesToCapture, requireViewContentFrameCoverage, rightEdgeWidthDragPlan, withViewContentTrace } from "../view-metrics-collection.mjs";
import { sourceIntervalSummary } from "./cases/plain-view.mjs";

const PROBE = fileURLToPath(new URL("../fixtures/plain-view/probe/", import.meta.url));
const descriptor = Object.freeze({
  plugin: "probeplain",
  startContentTrace: (s, surface) => s.run("probeplain.measure", { action: "start" }, surface),
  stopContentTrace: (s, surface) => s.run("probeplain.measure", { action: "stop" }, surface),
});

/** A registry folder that lists only the probe, and its built index. */
function probeRegistry(sok) {
  const folder = mkdtempSync(join(tmpdir(), "soksak-plain-registry-"));
  for (const name of ["plugins", "sidecars", "packs"]) mkdirSync(join(folder, name));
  writeFileSync(join(folder, "revoked.json"), `${JSON.stringify({ plugins: [], sidecars: [] })}\n`);
  const pack = pnpmPack(PROBE, join(folder, "releases"));
  const manifest = JSON.parse(readFileSync(join(PROBE, "plugin.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(PROBE, "package.json"), "utf8"));
  writeFileSync(join(folder, "plugins", `${manifest.id}.json`), JSON.stringify(pluginEntry(manifest, pkg, pack, new Set()), null, 2));
  execFileSync(sok, ["registry", "build", folder], { encoding: "utf8" });
  return folder;
}

async function pluginChange(s, action, run) {
  const offsets = currentEventOffsets(s.app.configDir);
  await run();
  await pluginChangeApplied(s, offsets, action);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the drag of a view without plugin code reports the floor of its source intervals`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    const before = await s.get("core.plugins");
    const folder = probeRegistry(join(dirname(app.binary), "sok"));
    s.cleanup(() => rmSync(folder, { recursive: true, force: true }));
    s.cleanup(async () => {
      await s.windows(1, "the page was not ready for the cleanup");
      if ((await s.get("core.plugins")).plugins.find((row) => row.id === "probeplain")?.installed) {
        await pluginChange(s, "the removal of probeplain", () => s.run("core.plugins.remove", { plugin: "probeplain" }));
      }
      await s.run("core.plugins.registry", { index: before.registry });
    });
    await s.run("core.plugins.registry", { index: pathToFileURL(join(folder, "index.json")).href });
    await s.until("core.plugins", (value) => value.plugins.some((row) => row.id === "probeplain"), "the registry did not list the probe");
    await pluginChange(s, "the install of probeplain", () => s.run("core.plugins.install", { plugin: "probeplain" }));
    await fresh(s, { log: { frame: "trace" }, reads: ["plugin.probeplain.view.content_frame"] });

    const anchor = (await s.get("core.grid")).cards.find((item) => item.pane !== null);
    const split = await s.run("core.card.split", { card: anchor.id, side: "right", plugin: descriptor.plugin });
    const surface = split.tab;
    const grid = await s.get("core.grid");
    const card = grid.cards.find((item) => item.id === split.card);
    await s.presented();
    const traced = await withViewContentTrace(t, s, descriptor, surface, () =>
      drag(t, s, rightEdgeWidthDragPlan(grid, card), { capture: true }));
    const run = traced.action;
    const captured = frames(run.frames).map(readFrame);
    const mapped = requireViewContentFrameCoverage(mapViewContentFramesToCapture(traced.contentFrames, captured), {
      gestureStartedAtMs: run.ticks[0], gestureEndedAtMs: run.ticks.at(-1),
    });
    const summary = sourceIntervalSummary(mapped, run.ticks[0], run.ticks.at(-1));
    const directory = join(app.configDir, "logs", "plain-view-benchmark");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${process.pid}.json`), `${JSON.stringify({ summary, contentFrames: traced.contentFrames, ticks: run.ticks }, null, 2)}\n`);
    t.diagnostic(`${app.name}: source intervals ${JSON.stringify(summary)}, ${captured.length} recorded frames, longest gap ${run.longestGap} ms`);
    assert.ok(summary.count > 1, "the gesture has too few source frames");
    await s.run("core.tab.close", { tab: surface });
  });
}
