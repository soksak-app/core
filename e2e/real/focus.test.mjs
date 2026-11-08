// Checks that the text field of a view does not receive the focus for a moment when an image region of another card is really
// pressed (V5-114, V5-114-1). An image region is click-transparent, so a press lets the main document take the focus back, and a
// text field that stayed as activeElement received the focus at that moment and was shown. The check records the whole process of
// a real HID click, collects every core.focus change in that time, and confirms that there is no focus transition into the text
// field and that the native first responder goes to the pressed image region. The image regions are those of the raster probe,
// and the text field is that of the view of the input probe.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { frames } from "@soksak/window-check/frame.mjs";
import { imageRect, readyInputProbe, rasterProbeTab } from "../input-probe.mjs";
import { bringFront, click, requireTrusted, screenCenter } from "@soksak/window-check/hid.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real image region press never moves focus to a view text field`, { timeout: 120000 }, async (t) => {
    requireTrusted();
    const s = await open(t, app);
    await fresh(s);
    const first = await rasterProbeTab(s);
    const second = await rasterProbeTab(s, { card: first.card, split: "right" });
    const regions = [first, second];
    const { tab: probe } = await s.run("core.card.split", { card: second.card, side: "bottom", plugin: "probeinput" });
    s.cleanup(() => s.run("core.tab.close", { tab: probe }));
    await readyInputProbe(s, probe);
    await s.presented();

    // Really presses the text field to give it the focus. The activeElement of the document stays on the field after that.
    const field = await s.rect("probeinput.field", undefined, probe);
    const point = await bringFront(s, app, field);
    click(point.x, point.y);
    await s.until("core.focus", (focus) => focus?.name === "probeinput.field" && focus.surface === probe,
      "a real click on the view text field did not give it focus in core.focus");

    // The recording sends stop once, and the session cleanup stops a recording that was not stopped and deletes the folder (Session.record).
    const recording = await s.record();
    const directory = recording.frames;
    const focus = await s.collect("core.focus");
    for (const region of regions) {
      const target = await screenCenter(s, await imageRect(s, region.surface));
      click(target.x, target.y);
      await s.until("host.window", (window) => window.responder?.surface === region.surface,
        `${region.surface} did not become the native first responder after a real click`);
    }
    const { displayed } = await s.presented();
    const stopped = await recording.stop({ after: displayed });
    const values = await focus.stop();

    assert.equal(stopped.limited, false, "the recording reached its frame limit");
    assert.ok(frames(directory).length > 0, "the recording has no frames");
    assert.ok(stopped.longestGap <= 100, `the recording has a ${stopped.longestGap}ms gap`);
    // The first value is the state (text field) when the watch starts. Every focus that enters the field again after that is a transition.
    const transitions = values.slice(1).filter((value, index) => value?.name === "probeinput.field" &&
      values[index]?.name !== "probeinput.field");
    assert.deepEqual(transitions, [], `focus moved to the view text field during the image region presses: ${JSON.stringify(values)}`);
    const host = await s.get("host.window");
    assert.equal(host.responder?.surface, second.surface, "the last pressed image region is not the native first responder");
    assert.deepEqual(host.regions.filter((region) => region.focused).map((region) => region.surface), [second.surface]);
    t.diagnostic(`core.focus values ${JSON.stringify(values)}; ${stopped.count} frames, maximum gap ${stopped.longestGap}ms`);
  });
}
