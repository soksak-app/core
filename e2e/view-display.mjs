// Measures view display through the declared window-check session interface.
import assert from "node:assert/strict";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";

/** Samples per axis of the surface area; colour variation measures only the sampled area, not plugin readiness. */
const SAMPLES = 16;

/** The number of distinct colours at the sampled points of the surface area of the frame. */
function colours(frame, rect) {
  const ratio = frame.scale * frame.contentScale;
  const seen = new Set();
  for (let i = 1; i < SAMPLES; i++) {
    for (let j = 1; j < SAMPLES; j++) {
      const x = Math.floor(frame.content.x * frame.scale + (rect.x + (rect.w * i) / SAMPLES) * ratio);
      const y = Math.floor(frame.content.y * frame.scale + (rect.y + (rect.h * j) / SAMPLES) * ratio);
      assert.ok(x >= 0 && x < frame.width && y >= 0 && y < frame.height,
        `surface sample (${x}, ${y}) lies outside capture ${frame.width}x${frame.height}`);
      seen.add(pixel(frame, x, y).join(","));
    }
  }
  return seen.size;
}

/** Runs the view display assertions; readRecording supplies decoded frames at the recording boundary. */
export async function observeViewDisplay(s, t, readRecording = (directory) => frames(directory).map(readFrame), verifyContent, paramsForPlugin = () => undefined) {
  const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.plugin === "terminal"));
  assert.ok(card, "no card holds the fixture terminal");
  const installed = await s.get("core.plugins");
  assert.equal(installed.error, null, `installed plugins failed: ${installed.error}`);
  const views = installed.plugins.filter((plugin) => plugin.installed?.enabled && plugin.composition === "view");
  t.diagnostic(`installed view plugins: ${views.map((plugin) => plugin.id).join(", ") || "none"}`);
  assert.ok(views.length > 0, `core.plugins lists no installed enabled plugin with composition view: ${JSON.stringify(installed.plugins)}`);
  for (const view of views) {
    const recording = await s.record({});
    let displayed = 0;
    let stopped;
    let tab;
    let verifyPixels;
    try {
      try {
        ({ tab } = await s.run("core.card.add-tab", { card: card.id, plugin: view.id, params: paramsForPlugin(view.id) }));
        await s.until("core.surfaces", (all) => all.some((item) => item.surface === tab && item.visible
          && item.exposes.includes("status core.surface.document")), `view ${view.id} did not show its document`);
        const document = await s.get("core.surface.document", tab);
        if (verifyContent) verifyPixels = await verifyContent({ plugin: view.id, tab, document });
        ({ displayed } = await s.presented());
      } finally {
        stopped = await recording.stop({ after: displayed ? displayed + 100 : 0 });
      }
      const captured = readRecording(recording.frames);
      assert.equal(stopped.limited, false, `${view.id}: recording reached its bounded buffer`);
      assert.equal(captured.length, stopped.count, `${view.id}: missing finalized frame files or frame count mismatch`);
      assert.ok(captured.length > 1, `${view.id}: recording has ${captured.length} frames`);
      const now = (await s.get("core.surfaces")).find((item) => item.surface === tab && item.visible);
      assert.ok(now, `${view.id}: opened tab ${tab} is not visible`);
      assert.equal(now.status.phase, "ready", `${view.id}: surface failed: ${now.status.error}`);
      assert.equal(now.composition, "view", `${view.id} reports composition ${now.composition}`);
      assert.deepEqual((await s.get("core.surface.document", tab)).unbound, [],
        `${view.id}: ready view document controls without a command or dom name`);
      const counts = captured.map((frame) => colours(frame, now.applied));
      const first = counts.findIndex((count) => count > 1);
      if (!verifyPixels) {
        assert.ok(first >= 0, `${view.id}: sampled surface area is blank in ${counts.length} frames`);
        assert.ok(counts.at(-1) > 1, `${view.id}: the last sampled surface area is blank`);
      }
      if (verifyPixels) await verifyPixels({ captured, rect: now.applied, directory: recording.frames });
      t.diagnostic(`${view.id}: first varied-area frame ${first < 0 ? "none" : first + 1} of ${captured.length}, gap=${stopped.longestGap}ms`);
    } finally {
      if (tab) {
        await s.run("core.tab.close", { tab });
        await s.until("core.surfaces", (all) => !all.some((item) => item.surface === tab),
          `view ${view.id} tab ${tab} did not close`);
      }
    }
  }
  assert.deepEqual((await s.get("core.page.audit")).unbound, [], "main document controls without a command or dom name");
}

/** Requires each installed view to have an explicit content case before accepting its display. */
export async function checkViewDisplay(s, t, readRecording, contentCases = new Map()) {
  await observeViewDisplay(s, t, readRecording, async (observation) => {
    const content = contentCases.get(observation.plugin);
    assert.equal(typeof content?.ready, "function",
      `${observation.plugin}: tab ${observation.tab} has no explicit content case`);
    const verifyPixels = await content.ready(s, observation);
    assert.equal(typeof verifyPixels, "function",
      `${observation.plugin}: tab ${observation.tab} has no captured-pixel verifier`);
    return verifyPixels;
  }, (plugin) => contentCases.get(plugin)?.params);
}
