// Status subscriptions of a view continue while its raster is hidden: a watch of a status of a hidden raster probe receives the change
// that a command of the hidden view makes, without native drawing, focus or activation.
// One parent owns the app sessions so their bounded watches and inactive audits
// finish together through the maintained session cleanup path.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh, joinedFailure, START_PLUGIN } from "./fixture.mjs";
import { addRasterTab, REGION } from "./raster-probe.mjs";

function nonDrawing(host, surface) {
  const regions = host.regions.filter(region => region.surface === surface && region.name === REGION);
  return regions.length === 0 || regions.every(region => region.drawing === false);
}

async function addedTab(session, card, plugin) {
  const { tab } = await session.run("core.card.add-tab", { card, plugin });
  session.cleanup(async () => {
    const grid = await session.get("core.grid");
    if (grid.cards.some(item => item.tabs?.some(entry => entry.id === tab))) {
      const result = await session.run("core.tab.close", { tab });
      assert.equal(result.closed, true, `hidden status fixture ${tab} did not close`);
    }
  });
  return tab;
}

test("hidden view statuses notify through every inactive host session", { timeout: 120000 }, async t => {
  for (const app of Object.values(APPS)) {
    const session = await open(t, app, { inactive: true });
    if (!session) continue;
    await t.test(`${app.name}: a hidden raster probe status reaches its admitted watch without a raster`, { timeout: 30000 }, async child => {
      await fresh(session);
      const { card, surface } = await addRasterTab(session);
      session.cleanup(async () => {
        const grid = await session.get("core.grid");
        if (grid.cards.some(item => item.tabs?.some(entry => entry.id === surface))) {
          const result = await session.run("core.tab.close", { tab: surface });
          assert.equal(result.closed, true, `hidden status fixture ${surface} did not close`);
        }
      });
      const alternative = await addedTab(session, card, START_PLUGIN);
      await session.run("core.tab.select", { tab: surface });
      await session.until("core.surfaces", surfaces => surfaces.some(item => item.surface === surface && item.visible &&
        item.status?.phase === "ready" && item.exposes.includes("status rasterprobe.session") &&
        item.exposes.includes("command rasterprobe.rows")),
      "the raster probe did not register its session status and rows command");
      const before = await session.until("rasterprobe.session", value => typeof value.session === "string" && value.connected,
        "the raster probe did not open its session", { surface });
      // A row count that the session does not hold yet marks the change that the watch waits for.
      const count = (before.rows ?? 0) + 3;
      let admit, rejectAdmission;
      const admitted = new Promise((resolve, reject) => { admit = resolve; rejectAdmission = reject; });
      let first = true;
      let commandIssued = false;
      let ended = false;
      const outcome = session.client.watch(session.window, "rasterprobe.session", value => {
        if (first) {
          assert.notEqual(value.rows, count, "the initial session already holds the marked row count");
          first = false;
          admit();
          return false;
        }
        if (value.rows !== count) return false;
        assert.equal(commandIssued, true, "the marked notification preceded the measured command");
        return true;
      }, { surface }).then(value => {
        ended = true;
        return { value };
      }, error => {
        ended = true;
        rejectAdmission(error);
        return { error };
      });
      let failure;
      try {
        // Client.watch has no ready property. Its initial predicate invocation
        // is the observable admission of this exact target subscription.
        await admitted;
        await session.run("core.tab.select", { tab: alternative });
        await session.until("core.surfaces", surfaces => surfaces.some(item => item.surface === surface && !item.visible) &&
          surfaces.some(item => item.surface === alternative && item.visible),
        "the alternative tab did not hide the watched raster probe");
        await session.until("host.window", host => nonDrawing(host, surface),
          "the hidden raster probe still has a drawing native region");
        commandIssued = true;
        await session.run("rasterprobe.rows", { count }, surface);
        const result = await outcome;
        if (result.error) throw result.error;
        assert.equal(result.value.rows, count, "the watched status omitted the change of the hidden view");
        const surfaces = await session.get("core.surfaces");
        assert.ok(surfaces.some(item => item.surface === surface && !item.visible), "the status change uncovered the raster probe");
        const host = await session.get("host.window");
        assert.ok(nonDrawing(host, surface), "the status change enabled native drawing");
        assert.equal(host.active, false, "the status observation activated the application");
        child.diagnostic(`${app.name}: admitted hidden status watch delivered rows ${count}; native drawing remained off`);
      } catch (error) {
        failure = error;
      }
      // The client owns unsubscription on completion, failure and the close of the connection. A watch has no time limit, so a
      // setup that failed while the watch is still open ends the check with that failure; the connection that the check closes
      // at its end ends the watch. Otherwise retain both setup and watch failures if distinct.
      if (failure && !ended) throw failure;
      const result = await outcome;
      if (failure && result.error && failure !== result.error) {
        throw joinedFailure("hidden status preparation and its watch both failed", [failure, result.error]);
      }
      if (failure) throw failure;
      if (result.error) throw result.error;
    });
  }
});
