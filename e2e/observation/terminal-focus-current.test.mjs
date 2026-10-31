// Observes terminal click delivery without replacing the current tabs or activating the application.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a current terminal view receives the click and native focus`, { timeout: 30000 }, async (t) => {
    const started = performance.now();
    t.diagnostic(`running ${app.name}: current terminal focus`);
    const s = await open(t, app);
    const initialLayout = await s.get("core.layout");
    assert.ok(initialLayout?.state, "the observation requires an open workspace layout");
    const layout = initialLayout.state;
    const surfaces = await s.get("core.surfaces");
    const terminal = surfaces.find((surface) => surface.plugin === "terminal" && surface.visible && surface.composition === "view");
    assert.ok(terminal?.applied, "a visible terminal view is required");
    const { surface, applied: rect } = terminal;
    const before = await s.get("host.window");
    const trace = await s.get("terminal.pointer.trace", surface);
    assert.equal(trace.enabled, false, "the observation requires an idle terminal pointer trace");
    assert.equal(before.active, false, "the observation requires an inactive application");
    const point = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    await s.run("terminal.pointer.trace", { action: "start" }, surface);
    let tracing = true;
    s.cleanup(async () => {
      if (tracing) await s.run("terminal.pointer.trace", { action: "stop" }, surface);
    });
    const recording = await s.record();
    let stopped = false;
    s.cleanup(async () => {
      if (!stopped) await recording.stop({ after: 0 });
    });
    await s.click(point.x, point.y);
    const { displayed } = await s.presented();
    stopped = true;
    const captured = await recording.stop({ after: displayed + 100 });
    const decoded = frames(recording.frames).map(readFrame);
    assert.equal(decoded.length, captured.count, "every captured frame must decode");
    assert.ok(decoded.length >= 2, "the recording must cover the whole click");
    assert.equal(captured.limited, false, "the recording reached its limit");
    assert.ok(captured.longestGap <= 33, `recording frame gap ${captured.longestGap}ms exceeds 33ms`);
    const after = await s.get("host.window");
    const input = await s.run("terminal.pointer.trace", { action: "stop" }, surface);
    tracing = false;
    const view = after.documents.find((document) => document.surface === surface && document.document === "");
    const region = after.regions.find((region) => region.surface === surface && region.name === "view");
    t.diagnostic(JSON.stringify({ surface, point, view, region, responder: after.responder, input,
      frames: captured.count, longestGap: captured.longestGap, endpoint: s.client.endpoint }));
    assert.deepEqual((await s.get("core.layout")).state, layout, "click observation changed the layout");
    assert.equal(after.active, false, "the click activated the application");
    assert.equal(view?.visible, true, "the terminal input view is hidden while its card is visible");
    // The view handles the pointer and its declared focus command focuses the native text input region.
    assert.equal(region?.focused, true, "the terminal text input region did not receive focus");
    assert.equal(after.responder?.surface, surface, "the native first responder did not enter the terminal view");
    assert.equal(input.overflow, false, "the terminal pointer trace lost events");
    for (const type of ["pointerdown", "pointerup"]) {
      assert.ok(input.entries.some((event) => event.kind === "pointer-dom" && event.type === type && event.trusted),
        `the terminal view received no trusted ${type} from the observed click`);
    }
    t.diagnostic(`passed ${app.name}: current terminal focus in ${(performance.now() - started).toFixed(1)}ms`);
  });
}
