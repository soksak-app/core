// Checks native view/main focus, text retention, picker Escape without activation. The text field of the view of the input probe
// reports its focus and its value.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { fresh } from "./fixture.mjs";
import { fieldPoint, inputProbeTab, pressInKeyWindow } from "./input-probe.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: an inactive view retains input across main focus and handles picker Escape`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { log: { lifecycle: "info", input: "info" }, reads: [
      "native.record.info", "native.input.key_down", "native.window.first_responder",
    ] });
    await keepCommonSettings(s);
    await s.selectInputSource("latin");
    const probe = await inputProbeTab(s);
    const project = await s.get("core.project");
    const space = project.spaces.find(item => item.id === project.activeSpaceId);
    const card = (await s.get("core.grid")).cards.find(item => item.tabs.some(tab => tab.id === probe.surface));
    assert.ok(space && card, "the fixture view has no active space or owning card");
    const initialWindow = await s.get("host.window");
    assert.equal(initialWindow.active, false, "the inactive input check requires a background application");
    const clickField = async () => {
      // A press alone does not give page focus in an inactive application: the move before it makes the window the virtual key
      // window, as a person's pointer over the window does (docs/spec/exposure.md#virtual-key-window).
      await pressInKeyWindow(s, await fieldPoint(s, probe.surface));
      await s.until("host.window", window => window.responder?.surface === probe.surface,
        "the native field press did not focus its view");
      await s.until("probeinput.field", value => value.focused,
        "the view field did not report focus", { surface: probe.surface });
      await s.presented();
    };
    const activity = await s.collect("host.window");
    const recording = await s.record();
    await clickField();
    const beforeInput = await s.get("core.surface.input", probe.surface);
    await s.press("x", { text: "x" });
    await s.until("core.surface.input", events => events.some(event => event.type === "keydown"
      && event.sequence > (beforeInput.at(-1)?.sequence ?? 0)),
    "the view received no DOM keydown after native delivery", { surface: probe.surface });
    t.diagnostic(`view key delivery: ${JSON.stringify({
      events: await s.get("core.surface.input", probe.surface),
      window: await s.get("host.window"),
      field: await s.get("probeinput.field", probe.surface),
    })}`);
    await s.until("probeinput.field", value => value.value === "x",
      "the focused view did not receive native text", { surface: probe.surface });

    await s.run("core.rename.begin", { kind: "space", id: space.id });
    await s.until("core.rename", value => value?.id === space.id, "the main rename field did not open");
    const rename = await s.rect("core.rename.input");
    await s.click(rename.x + rename.width / 2, rename.y + rename.height / 2);
    await s.until("core.focus", focus => focus?.name === "core.rename.input",
      "native focus did not enter the main document");
    await s.until("host.window", window => window.responder?.owner === "workbench",
      "the main rename field did not become the native first responder");
    await s.presented();
    await s.press("y", { text: "y" });
    await s.until("core.rename", value => value?.value.includes("y"), "the main document did not receive native text");
    assert.equal((await s.get("probeinput.field", probe.surface)).value, "x",
      "main-document input changed the view text");
    await s.press("Escape");
    await s.until("core.rename", value => value === null, "native Escape did not cancel main-document rename");
    assert.equal((await s.get("core.project")).spaces.find(item => item.id === space.id).title, space.title,
      "cancelled rename changed the space title");

    await clickField();
    assert.equal((await s.get("probeinput.field", probe.surface)).value, "x",
      "returning native focus did not preserve the view text");
    // The caret is put at the end of the retained text, so typing adds to it.
    await s.run("probeinput.select", { target: "field", start: 1 }, probe.surface);
    await s.press("z", { text: "z" });
    await s.until("probeinput.field", value => value.value === "xz",
      "native input did not return to the retained view", { surface: probe.surface });
    await s.run("core.card.menu", { card: card.id, menu: "add" });
    await s.until("host.window", window => window.modal?.id === "picker" && window.modal.shown,
      "the picker did not appear over the view");
    await s.press("Escape");
    await s.until("host.window", window => window.modal === null, "native Escape did not close the picker");
    assert.equal((await s.get("core.picker")).open, false);
    const { displayed } = await s.presented();
    const stopped = await recording.stop({ after: displayed + 100 });
    const windows = await activity.stop();
    const captured = frames(recording.frames).map(readFrame);
    assert.equal(captured.length, stopped.count, "the focus gesture has missing frame files");
    assert.ok(captured.length > 1, "the focus gesture has no complete recording");
    assert.equal(stopped.limited, false, "the focus gesture exceeded its recording capacity");
    assert.ok(windows.length > 0 && windows.every(window => window.active === false),
      "the native gesture activated the application");
    assert.deepEqual((await s.get("core.workbench.audit")).unbound, []);
    t.diagnostic(`native focus round trip and picker Escape: ${captured.length} frames, gap ${stopped.longestGap}ms`);
  });
}
