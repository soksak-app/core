// Checks native view/main focus, text retention, picker Escape without activation.
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { fresh } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: an inactive view retains input across main focus and handles picker Escape`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { log: { lifecycle: "info", input: "info" }, reads: [
      "native.record.info", "native.input.key_down", "native.window.first_responder",
    ] });
    await keepCommonSettings(s);
    await s.selectInputSource("com.apple.keylayout.ABC");
    const browser = (await s.get("core.surfaces")).find(item => item.plugin === "browser" && item.visible);
    assert.ok(browser, "the fixture has no visible browser view");
    await s.until("core.surfaces", all => all.some(item => item.surface === browser.surface
      && item.exposes.includes("status browser.address.text") && item.exposes.includes("dom browser.address")),
    "the browser did not register its address field");
    const project = await s.get("core.project");
    const space = project.spaces.find(item => item.id === project.activeSpaceId);
    const card = (await s.get("core.grid")).cards.find(item => item.tabs.some(tab => tab.id === browser.surface));
    assert.ok(space && card, "the fixture view has no active space or owning card");
    const initialWindow = await s.get("host.window");
    assert.equal(initialWindow.active, false, "the inactive input check requires a background application");
    const clickAddress = async () => {
      const field = await s.rect("browser.address", undefined, browser.surface);
      assert.ok(field.width > 0 && field.height > 0, "the browser address has no input area");
      await s.click(field.x + field.width / 2, field.y + field.height / 2);
      await s.until("host.window", window => window.responder?.surface === browser.surface,
        "the native address press did not focus its view");
      await s.until("browser.address.text", value => value.focused,
        "the address control did not report focus", { surface: browser.surface });
      await s.presented();
    };
    const activity = await s.collect("host.window");
    const recording = await s.record();
    await clickAddress();
    const beforeInput = await s.get("core.surface.input", browser.surface);
    await s.press("x", { text: "x" });
    await s.until("core.surface.input", events => events.some(event => event.type === "keydown"
      && event.sequence > (beforeInput.at(-1)?.sequence ?? 0)),
    "the view received no DOM keydown after native delivery", { surface: browser.surface });
    t.diagnostic(`view key delivery: ${JSON.stringify({
      events: await s.get("core.surface.input", browser.surface),
      window: await s.get("host.window"),
      text: await s.get("browser.address.text", browser.surface),
    })}`);
    await s.until("browser.address.text", value => value.value === "x",
      "the focused view did not receive native text", { surface: browser.surface });

    await s.run("core.rename.begin", { kind: "space", id: space.id });
    await s.until("core.rename", value => value?.id === space.id, "the main rename field did not open");
    const rename = await s.rect("core.rename.input");
    await s.click(rename.x + rename.width / 2, rename.y + rename.height / 2);
    await s.until("core.focus", focus => focus?.name === "core.rename.input",
      "native focus did not enter the main document");
    await s.until("host.window", window => window.responder?.owner === "page",
      "the main rename field did not become the native first responder");
    await s.presented();
    await s.press("y", { text: "y" });
    await s.until("core.rename", value => value?.value.includes("y"), "the main document did not receive native text");
    assert.equal((await s.get("browser.address.text", browser.surface)).value, "x",
      "main-document input changed the view text");
    await s.press("Escape");
    await s.until("core.rename", value => value === null, "native Escape did not cancel main-document rename");
    assert.equal((await s.get("core.project")).spaces.find(item => item.id === space.id).title, space.title,
      "cancelled rename changed the space title");

    await clickAddress();
    assert.equal((await s.get("browser.address.text", browser.surface)).value, "x",
      "returning native focus did not preserve the view text");
    // Address focus selects its retained text; typing replaces that selection.
    await s.press("z", { text: "z" });
    await s.until("browser.address.text", value => value.value === "z",
      "native input did not return to the retained view", { surface: browser.surface });
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
    assert.deepEqual((await s.get("core.page.audit")).unbound, []);
    t.diagnostic(`native focus round trip and picker Escape: ${captured.length} frames, gap ${stopped.longestGap}ms`);
  });
}
