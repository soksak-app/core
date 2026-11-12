// Observes click delivery to a current raster probe view without replacing the current tabs or activating the application. The
// raster probe logs the pointer events of its image region (rasterprobe.input pointer) and focuses its region on a primary press.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, open, recordingSummary } from "@soksak/window-check/app.mjs";
import { RASTER, REGION } from "../raster-probe.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a current image region view receives the click and native focus`, { timeout: 30000 }, async (t) => {
    const started = performance.now();
    t.diagnostic(`running ${app.name}: current view focus`);
    const s = await open(t, app);
    const initialLayout = await s.get("core.layout");
    assert.ok(initialLayout?.state, "the observation requires an open workspace layout");
    const layout = initialLayout.state;
    const surfaces = await s.get("core.surfaces");
    const view = surfaces.find((surface) => surface.plugin === RASTER && surface.visible && surface.composition === "view");
    assert.ok(view?.applied, "a visible raster probe view is required");
    const { surface, applied: rect } = view;
    const before = await s.get("host.window");
    assert.equal(before.active, false, "the observation requires an inactive application");
    const point = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    // The pointer list of the probe starts empty, so every entry after the click belongs to it.
    await s.run("rasterprobe.input.clear", {}, surface);
    const recording = await s.record();
    let stopped = false;
    s.cleanup(async () => {
      if (!stopped) await recording.stop({ after: 0 });
    });
    // The recording is the evidence of the click.
    await s.click(point.x, point.y);
    const { displayed } = await s.presented();
    stopped = true;
    const captured = await recording.stop({ after: displayed + 100 });
    const after = await s.get("host.window");
    const input = await s.until("rasterprobe.input", (value) => value.pointer.some((event) => event.type === "pointerup"),
      "the raster probe view logged no pointerup of the click", { surface });
    const document = after.documents.find((item) => item.surface === surface && item.document === "");
    const region = after.regions.find((item) => item.surface === surface && item.name === REGION);
    t.diagnostic(JSON.stringify({ surface, point, view: document, region, responder: after.responder, input: input.pointer,
      recording: recordingSummary(captured),
      endpoint: s.client.endpoint }));
    assert.deepEqual((await s.get("core.layout")).state, layout, "click observation changed the layout");
    assert.equal(after.active, false, "the click activated the application");
    assert.equal(document?.visible, true, "the raster probe view is hidden while its card is visible");
    // The view handles the pointer and its primary press focuses its native image region.
    assert.equal(region?.focused, true, "the raster probe image region did not receive focus");
    assert.equal(after.responder?.surface, surface, "the native first responder did not enter the raster probe view");
    for (const type of ["pointerdown", "pointerup"]) {
      assert.ok(input.pointer.some((event) => event.type === type && event.trusted),
        `the raster probe view received no trusted ${type} from the observed click`);
    }
    t.diagnostic(`passed ${app.name}: current view focus in ${(performance.now() - started).toFixed(1)}ms`);
  });
}
