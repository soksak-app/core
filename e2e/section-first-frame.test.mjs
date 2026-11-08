// Measures by recording whether a section view shows a background other than the card colour while it is created
// (docs/spec/native-surfaces.md#view-surfaces). A reload of the main page creates every section view again; each recorded frame
// must show the colour that the section has at the end of the recording at an empty point of each section body, so a frame of
// the default backing of a web view before its page draws fails.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh, probeSidebarSets } from "./fixture.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";

const near = (a, b, tolerance) => a.every((value, index) => Math.abs(value - b[index]) <= tolerance);

/** The frame pixel at the window coordinate (points) point. */
function sample(frame, point) {
  const scale = frame.scale * frame.contentScale;
  return pixel(frame, Math.floor(frame.content.x * frame.scale + point.x * scale),
    Math.floor(frame.content.y * frame.scale + point.y * scale));
}

/** An empty point of the body of each shown section of the sidebar: 8 points inside the lower right corner of the section. */
async function sectionPoints(s, sidebar) {
  const sidebars = await s.until("core.sidebars", (value) => {
    const bar = value.find((item) => item.sidebar === sidebar);
    return bar?.sections.length > 0 && bar.sections.every((item) => item.mounted);
  }, `sidebar ${sidebar} did not mount its sections`);
  const at = sidebars.findIndex((item) => item.sidebar === sidebar);
  const first = sidebars.slice(0, at).reduce((sum, item) => sum + item.sections.length, 0);
  const points = [];
  for (const [offset, section] of sidebars[at].sections.entries()) {
    // A folded section has no body, and a tabs sidebar shows only the section of its selected tab.
    if (section.folded || (sidebars[at].layout === "tabs" && section.id !== sidebars[at].tab)) continue;
    const rect = await s.rect("core.sidebar.section", first + offset);
    assert.ok(rect.width > 16 && rect.height > 16, `section ${section.id} has no body to measure`);
    points.push({ id: section.id, x: rect.x + rect.width - 8, y: rect.y + rect.height - 8 });
  }
  assert.ok(points.length > 0, `sidebar ${sidebar} has no unfolded section`);
  return points;
}

async function record(s, action) {
  const { displayed } = await s.presented();
  const recording = await s.record();
  try {
    await action();
    const shown = await s.presented();
    const stop = await recording.stop({ after: Math.max(displayed, shown.displayed) + 100 });
    assert.equal(stop.limited, false, "the recording reached its frame cap");
    return frames(recording.frames).map(readFrame);
  } finally {
    // If the recording cannot be stopped, the session cleanup stops it (Session.record).
    rmSync(recording.frames, { recursive: true, force: true });
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a section view shows the card colour from its first frame`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    // The left sidebar shows the set of the configuration, whose sections a fixture configuration does not load.
    await probeSidebarSets(s);
    const points = await sectionPoints(s, "left");
    const captured = await record(s, async () => {
      const before = (await s.get("core.window.workbench")).start;
      await s.run("host.window.reload");
      await s.until("core.window.workbench", (workbench) => workbench.start !== before && workbench.readyState === "complete",
        "the workbench did not start again");
      await sectionPoints(s, "left");
    });
    assert.ok(captured.length > 1, `the recording has ${captured.length} frames`);
    const last = captured.at(-1);
    const differing = [];
    for (const point of points) {
      const expected = sample(last, point);
      for (const [index, frame] of captured.entries()) {
        const seen = sample(frame, point);
        if (!near(seen, expected, 12)) differing.push({ section: point.id, frame: index, seen, expected });
      }
    }
    t.diagnostic(`${captured.length} frames, ${points.length} sections, ${differing.length} differing samples ${JSON.stringify(differing.slice(0, 6))}`);
    assert.deepEqual(differing, [], "a section showed a colour other than its card colour while its view was created");
  });
}
