// Checks by recording that the dark border of the footer below the surface does not become empty while the vertical boundary is turned off.
// native/darwin/tests/webview_geometry_test.m checks the 1x and 2x scales and half-point surface sizes.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, drag, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";
import { rasterRow } from "./outside.mjs";

/** The paint of the document region of the layout probe while it is measured: a dark gray apart from the card and the plane. */
const MEASURED = [30, 30, 30];

/**
 * Paints the document region of the start tab in MEASURED and returns the marks of its surface, read from the declared position of
 * the surface (host.window) in points: top and bottom of the surface and cx, the column 24pt inside its right edge, which the
 * region (inset 8pt in the view) covers. The check drags the bottom boundary of the card, so the top and the right edge do not move.
 */
async function probeMarks(s, surface) {
  const colour = `rgb(${MEASURED.join(", ")})`;
  // The document applies a posted colour once its script listens, which its first report tells; a colour posted before that
  // reaches the document while it loads and is lost (docs/spec/native-surfaces.md#document-regions).
  await s.until("layoutprobe.document", (value) => value.reported === true, `the document of ${surface} did not report`, { surface });
  await s.run("layoutprobe.document.color", { color: colour }, surface);
  await s.until("layoutprobe.document", (value) => value.color === colour, `${surface} did not paint its document region`, { surface });
  await s.presented();
  const frame = (await s.get("host.window")).surfaces.find((item) => item.id === surface)?.frame;
  if (!frame?.width) throw new Error(`the start surface ${surface} has no declared frame`);
  return { top: frame.y, bottom: frame.y + frame.height, cx: frame.x + frame.width - 24, colour: MEASURED };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: vertical dragging preserves the footer border`, async (t) => {
    const s = await open(t, app);
    const { surface } = await fresh(s);
    const marks = await probeMarks(s, surface);
    const run = await drag(s, { axis: "y", line: 1, dx: 0, dy: 173, ms: 400, times: 2 }, { capture: true });
    const recorded = frames(run.frames);
    assert.ok(recorded.length > 30, `only ${recorded.length} frames recorded`);
    let measured = 0, low = Infinity, high = -Infinity;
    let worst = { brightness: 0, frame: -1 };
    let offset = null;
    recorded.forEach((path, index) => {
      const frame = readFrame(path);
      const scale = frame.contentScale * frame.scale;
      const contentBottom = Math.round(frame.content.height * scale);
      // The bottom edge of the surface follows the last row of the document region painted with the measurement color. The distance
      // between that row and the bottom edge of the surface is measured against the declared position in the first frame.
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
    assert.ok(measured > recorded.length * .9, `only ${measured}/${recorded.length} footer positions measured`);
    assert.ok(high - low > 100, `the recorded surface moved only ${high - low}pt; ` +
      `divider ${JSON.stringify(run.boundary)}, probe marks ${JSON.stringify(marks)}, recording ${run.frameDir}`);
    assert.ok(worst.brightness <= 80,
      `footer brightness ${worst.brightness} exceeds the dark border in frame ${worst.frame} of ${recorded.length}`);
  });
}

for (const app of Object.values(APPS)) {
  // The content foot of a card shows the bottom text that the plugin of the active tab reports (docs/spec/plugins.md#tab-reports):
  // the footer that the layout probe declares at its start, and a footer that it reports later.
  test(`${app.name}: the content footer shows the footer text that the active tab's plugin reports`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    const { surface } = await fresh(s);
    const { footer } = await s.get("layoutprobe.view", surface);
    const shows = async (text, message) => {
      const grid = await s.until("core.grid", (value) => {
        const card = value.cards.find((item) => item.tabs?.some((tab) => tab.id === surface));
        return card?.active === surface && card.tabs.find((tab) => tab.id === surface)?.footer === text;
      }, message);
      const card = grid.cards.find((item) => item.tabs?.some((tab) => tab.id === surface));
      assert.equal(card.status, text, `the card footer does not show the footer of its active tab: ${JSON.stringify(card)}`);
    };
    assert.ok(footer, "the layout probe declared no footer at its start");
    await shows(footer, "the probe tab did not report its start footer");
    const reported = `footer ${surface}`;
    await s.run("layoutprobe.footer", { text: reported }, surface);
    await shows(reported, "the probe tab did not report its later footer");
  });
}
