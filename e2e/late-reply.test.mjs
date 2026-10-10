// Checks that the host discards, without an error, the reply of a surface that arrives after the surface closed, and keeps it as an observation (docs/spec/exposure.md#relay).
//
// The diagnostic method diagnostics.surface.hold holds the reply of the surface until the host removes that surface, so the reply does not depend on time
// and arrives after the request ended (docs/spec/endpoint.md).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, failure, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { readEventLines } from "@soksak/window-check/event-log.mjs";
import { heldRepliesSent, lateReplyFindings } from "./late-reply.mjs";

/** A card that has a tab id. */
const holder = (grid, tab) => grid?.cards.find((card) => card.tabs.some((entry) => entry.id === tab));

for (const app of Object.values(APPS)) {
  test(`${app.name}: a surface reply that arrives after its surface closed is discarded as an observation`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const { tab } = await s.run("core.card.add-tab", { card: "browser", plugin: "browser" });
    // If the check fails before it closes the tab, it closes the remaining tab. The hold of the closed surface ends then as well.
    s.cleanup(async () => {
      if (holder(await s.get("core.grid"), tab)) await s.run("core.tab.close", { tab });
    });
    await s.until("core.surfaces", (surfaces) => surfaces.some((item) =>
      item.surface === tab && item.visible && item.status.phase === "ready"),
    "the new browser tab did not become ready");
    const transcript = await s.transcript();
    s.cleanup(() => transcript.stop());
    const offsets = s.eventStart;

    await s.request("diagnostics.surface.hold", { surface: tab });
    const pending = failure(s.run("core.surface.hit", { x: 0, y: 0 }, tab));
    await s.request("diagnostics.surface.held", { surface: tab });
    t.diagnostic(`the reply of ${tab} is held; closing the tab`);
    await s.run("core.tab.close", { tab });
    assert.equal(await pending, 1003, "the request to the closed surface did not end with 1003");
    // The page sends this line after it answered the reply that the host held. The observation line of the host was written to the log before that answer.
    const sent = heldRepliesSent(tab, 1);
    await transcript.until((lines) => lines.includes(sent), `the page did not report "${sent}"`);

    await s.flushLog();
    const { lines } = readEventLines(s.app.configDir, offsets);
    const { observations, errors } = lateReplyFindings(lines, tab);
    assert.deepEqual(errors, [], `the late reply of ${tab} wrote error lines`);
    assert.equal(observations.length, 1,
      `the application log does not hold one late reply observation of ${tab}: ${JSON.stringify(lines)}`);
  });
}
