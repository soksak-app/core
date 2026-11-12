// Checks that the text field of a view does not receive the focus for a moment when an image region of another card is
// pressed (V5-114, V5-114-1). An image region is click-transparent, so a press lets the main document take the focus back, and a
// text field that stayed as activeElement received the focus at that moment and was shown. The check records the whole process of
// a click that the host emulates inside the application as evidence, collects every core.focus change in that time, and confirms that there is no focus transition into the text
// field and that the native first responder goes to the pressed image region. The image regions are those of the raster probe,
// and the text field is that of the view of the input probe.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open, recordingSummary } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { imageRect, readyInputProbe, rasterProbeTab } from "./input-probe.mjs";

/** The center of the rect `rect` of s.rect in the coordinates of the window that the emulated pointer takes. */
const center = (rect) => [rect.document.x + rect.x + rect.width / 2, rect.document.y + rect.y + rect.height / 2];

for (const app of Object.values(APPS)) {
  test(`${app.name}: an image region press never moves focus to a view text field`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const first = await rasterProbeTab(s);
    const second = await rasterProbeTab(s, { card: first.card, split: "right" });
    const regions = [first, second];
    const { tab: probe } = await s.run("core.card.split", { card: second.card, side: "bottom", plugin: "probeinput" });
    s.cleanup(() => s.run("core.tab.close", { tab: probe }));
    await readyInputProbe(s, probe);
    await s.presented();

    // Presses the text field to give it the focus. The activeElement of the document stays on the field after that.
    await s.click(...center(await s.rect("probeinput.field", undefined, probe)));
    await s.until("core.focus", (focus) => focus?.name === "probeinput.field" && focus.surface === probe,
      "a click on the view text field did not give it focus in core.focus");

    // The recording sends stop once, and the session cleanup stops a recording that was not stopped and deletes the folder (Session.record).
    const recording = await s.record();
    const focus = await s.collect("core.focus");
    for (const region of regions) {
      const point = center(await imageRect(s, region.surface));
      await s.click(...point);
      // The press reaches the page through the region, and the page gives the region the focus with a view call that it makes
      // in its pointerdown handler. The answer of the release follows the receipt of the press in the document, not that call,
      // and the web view of the surface holds the first responder until the call arrives; the region holds the focus once it ran.
      await s.until("host.window", (window) => window.responder?.surface === region.surface &&
        window.regions.some((shown) => shown.surface === region.surface && shown.focused),
        `${region.surface} did not take the focus after its click`);
    }
    const { displayed } = await s.presented();
    const stopped = await recording.stop({ after: displayed });
    const values = await focus.stop();

    // The first value is the state (text field) when the watch starts. Every focus that enters the field again after that is a transition.
    const transitions = values.slice(1).filter((value, index) => value?.name === "probeinput.field" &&
      values[index]?.name !== "probeinput.field");
    assert.deepEqual(transitions, [], `focus moved to the view text field during the image region presses: ${JSON.stringify(values)}`);
    const host = await s.get("host.window");
    assert.equal(host.responder?.surface, second.surface, "the last pressed image region is not the native first responder");
    // The responder names the class that holds the keyboard: the region, or the surface that waits for its region.
    assert.deepEqual(host.regions.filter((region) => region.focused).map((region) => region.surface), [second.surface],
      `the last pressed image region does not hold the focus: responder ${JSON.stringify(host.responder)}, regions ` +
      JSON.stringify(host.regions.map(({ surface, focused, visible }) => ({ surface, focused, visible }))));
    t.diagnostic(`core.focus values ${JSON.stringify(values)}; ${recordingSummary(stopped)}`);
  });
}
