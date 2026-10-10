// Checks by recording that the dark border of the footer below the surface does not become empty while the vertical boundary is turned off.
// native/darwin/tests/webview_geometry_test.m checks the 1x and 2x scales and half-point surface sizes.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, drag, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";
import { rasterRow, terminalMarks } from "./outside.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: vertical dragging preserves the footer border`, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const initial = await s.get("host.window");
    const marks = await terminalMarks(s, { measured: true });
    const run = await drag(t, s, { axis: "y", line: 1, dx: 0, dy: 173, ms: 400, times: 2 }, { capture: true });
    const files = frames(run.frames);
    assert.ok(files.length > 30, `only ${files.length} frames recorded`);
    let measured = 0, low = Infinity, high = -Infinity;
    let worst = { brightness: 0, frame: -1 };
    let offset = null;
    files.forEach((path, index) => {
      const frame = readFrame(path);
      const scale = frame.contentScale * frame.scale;
      const contentBottom = Math.round(frame.content.height * scale);
      // The bottom edge of the surface is the last row of the terminal raster painted with the measurement background. The distance between that row and the bottom edge of the surface
      // is measured against the declared position in the first frame.
      const x = Math.round(marks.cx * scale);
      const line = rasterRow(frame, marks.colour, { from: contentBottom - 1, to: Math.round(marks.top * scale) });
      if (!line) return;
      offset ??= Math.round(marks.bottom * scale) - line.y;
      const bottom = line.y + offset - 1;
      measured++;
      low = Math.min(low, bottom / scale); high = Math.max(high, bottom / scale);
      for (let y = bottom + 1; y <= bottom + Math.ceil(3 * scale); y++) {
        const brightness = Math.min(...pixel(frame, x, y));
        if (brightness > worst.brightness) worst = { brightness, frame: index };
      }
    });
    assert.ok(measured > files.length * .9, `only ${measured}/${files.length} footer positions measured`);
    assert.ok(high - low > 100, `the recorded surface moved only ${high - low}pt; ` +
      `divider ${JSON.stringify(run.boundary)}, terminal marks ${JSON.stringify(marks)}, recording ${run.frameDir}`);
    assert.ok(worst.brightness <= 80,
      `footer brightness ${worst.brightness} exceeds the dark border in frame ${worst.frame} of ${files.length}`);
  });
}

for (const app of Object.values(APPS)) {
  // The content foot of a card shows the bottom text that the plugin of the active tab reports. For a terminal it is the working directory (docs/spec/plugins.md#tab-reports).
  test(`${app.name}: the content footer shows the footer text that the active tab's plugin reports`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    const { root } = await s.get("core.project");
    const grid = await s.until("core.grid", (value) => {
      const card = value.cards.find((item) => item.id === "terminal");
      return card?.tabs.find((tab) => tab.id === card.active)?.footer === root;
    }, "the terminal tab did not report its working directory as its footer");
    const card = grid.cards.find((item) => item.id === "terminal");
    assert.equal(card.status, root, `the terminal card footer does not show the working directory: ${JSON.stringify(card)}`);
  });
}
