// A layout draw that throws is shown once through the error display, and the main page keeps answering requests (F349). A later
// placement that succeeds withdraws that error (F587), which can happen in the next frame, so the record of the error in the log is
// what shows that the failure was displayed. The
// diagnostic method diagnostics.layout.fail makes the next draw throw (docs/spec/endpoint.md).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, untilEventLine } from "@soksak/window-check/event-log.mjs";
import { fresh, reading } from "./fixture.mjs";


for (const app of Object.values(APPS)) {
  test(`${app.name}: a layout draw that throws leaves the main page answering`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    s.expectError(/surface presentation failed: diagnostic layout fault/);
    const offsets = currentEventOffsets(app.configDir);
    assert.equal(await s.request("diagnostics.layout.fail"), null);
    // A resize lays the plane out again, and that draw throws.
    const { content } = await s.get("host.window");
    await s.run("host.window.resize", { width: content.width - 40, height: content.height });
    await untilEventLine(app.configDir, offsets, (line) => line.includes("surface presentation failed: diagnostic layout fault"), 30000,
      reading(app, ["workbench.record.error"]));
    // The page answers each request after the failure within the time limit of the request.
    for (let round = 0; round < 5; round++) assert.ok(Array.isArray(await s.get("core.surfaces")), `round ${round}: core.surfaces did not answer`);
    await s.run("host.window.resize", { width: content.width, height: content.height });
    await s.until("core.verify", (verify) => verify.failed === 0, "a later layout did not draw after the failure");
    await s.until("core.workbench.error", (text) => text === null, "the placement that succeeded left the failure in the banner");
  });
}
