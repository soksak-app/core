// Semantic screen subscriptions continue while the target's raster is hidden.
// One parent owns the app sessions so their bounded watches and inactive audits
// finish together through the maintained session cleanup path.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh, terminalCheckShell } from "./fixture.mjs";
import { textLines } from "./terminal-screen.mjs";

function nonDrawing(host, surface) {
  const regions = host.regions.filter(region => region.surface === surface && region.name === "view");
  return regions.length === 0 || regions.every(region => region.drawing === false);
}

async function addedTab(session, card, plugin) {
  const { tab } = await session.run("core.card.add-tab", { card, plugin });
  session.cleanup(async () => {
    const grid = await session.get("core.grid");
    if (grid.cards.some(item => item.tabs?.some(entry => entry.id === tab))) {
      const result = await session.run("core.tab.close", { tab });
      assert.equal(result.closed, true, `semantic screen fixture ${tab} did not close`);
    }
  });
  return tab;
}

test("hidden terminal and term screens notify through every inactive host session", { timeout: 120000 }, async t => {
  for (const app of Object.values(APPS)) {
    const session = await open(t, app, { inactive: true });
    if (!session) continue;
    for (const plugin of ["terminal", "term"]) {
      await t.test(`${app.name}: hidden ${plugin} output reaches its admitted screen watch without a raster`, { timeout: 30000 }, async child => {
        await fresh(session, { settings: { "term.shell": terminalCheckShell() } });
        let grid = await session.get("core.grid");
        const card = grid.cards.find(item => item.tabs?.some(tab => tab.plugin === "terminal"));
        assert.ok(card, "the fresh fixture has no real terminal tab card");
        let surface = card.tabs.find(tab => tab.plugin === plugin)?.id;
        if (!surface) surface = await addedTab(session, card.id, plugin);
        grid = await session.get("core.grid");
        let alternative = grid.cards.find(item => item.id === card.id).tabs.find(tab => tab.plugin === "browser")?.id;
        if (!alternative) alternative = await addedTab(session, card.id, "browser");
        await session.run("core.tab.select", { tab: surface });
        await session.until("core.surfaces", surfaces => surfaces.some(item => item.surface === surface && item.visible &&
          item.status?.phase === "ready" && item.exposes.includes(`status ${plugin}.screen`) &&
          item.exposes.includes(`command ${plugin}.screen.read`) && item.exposes.includes(`command ${plugin}.input`)),
        `${plugin} did not register its public screen and input interfaces`);
        await session.until(`${plugin}.session`, value => Boolean(value.sessionId) && value.cols > 0 && value.rows > 0,
          `${plugin} did not open its terminal session`, { surface });
        // Exactly one explicit screen snapshot precedes the watch. Nothing below
        // refreshes the screen, polls it, uncovers the target or changes focus.
        await session.run(`${plugin}.screen.read`, {}, surface);
        const marker = `SEMANTIC${process.pid}${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        let admit, rejectAdmission;
        const admitted = new Promise((resolve, reject) => { admit = resolve; rejectAdmission = reject; });
        let first = true;
        let inputIssued = false;
        const outcome = session.client.watch(session.window, `${plugin}.screen`, value => {
          const lines = textLines({ lines: value });
          if (first) {
            assert.equal(lines.some(line => line.includes(marker)), false, "initial screen already contains the unique marker");
            first = false;
            admit();
            return false;
          }
          if (!lines.includes(marker)) return false;
          assert.equal(inputIssued, true, "marker notification preceded the measured input command");
          return true;
        }, { surface, timeout: 20000 }).then(value => ({ value }), error => {
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
          "the alternative tab did not hide the watched terminal");
          await session.until("host.window", host => nonDrawing(host, surface),
            "the hidden terminal still has a drawing native region");
          inputIssued = true;
          await session.run(`${plugin}.input`, { bytes: `printf '${marker}\\n'\r` }, surface);
          const result = await outcome;
          if (result.error) throw result.error;
          assert.ok(textLines({ lines: result.value }).includes(marker), "the watched screen omitted executed output");
          const surfaces = await session.get("core.surfaces");
          assert.ok(surfaces.some(item => item.surface === surface && !item.visible), "semantic output uncovered the terminal");
          const host = await session.get("host.window");
          assert.ok(nonDrawing(host, surface), "semantic output enabled native drawing");
          assert.equal(host.active, false, "semantic observation activated the application");
          child.diagnostic(`${app.name}/${plugin}: admitted hidden screen watch delivered ${marker}; native drawing remained off`);
        } catch (error) {
          failure = error;
        }
        // The client owns unsubscription on completion, timeout and failure.
        // Always await it, and retain both setup and watch failures if distinct.
        const result = await outcome;
        if (failure && result.error && failure !== result.error) {
          throw new AggregateError([failure, result.error], "hidden screen preparation and its watch both failed");
        }
        if (failure) throw failure;
        if (result.error) throw result.error;
      });
    }
  }
});
