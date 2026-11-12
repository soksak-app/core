// Checks a native menu key equivalent from a focused plugin view. The window takes the press and the key as the virtual key
// window, and the key equivalent reaches the menu through the same path as in the key window of the active application, so the
// application and the input source of the person stay as they are (docs/spec/exposure.md#virtual-key-window).
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, keepCommonSettings, open, recordingSummary } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { fieldPoint, inputProbeTab } from "./input-probe.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: Command-zero in a focused view runs the native text-size menu command`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app, { inactive: true });
    await fresh(s, {
      log: { input: "info", lifecycle: "info", call: "debug" },
      reads: ["native.input.key_down", "native.record.info", "native.window.first_responder", "workbench.command"],
    });
    await keepCommonSettings(s);
    // The text field of the view of the input probe reports its focus and its value.
    const probe = await inputProbeTab(s);
    const card = (await s.get("core.grid")).cards.find(item => item.tabs.some(tab => tab.id === probe.surface));
    assert.ok(card, "the input probe has no owning card");
    const field = await fieldPoint(s, probe.surface);
    const recording = await s.record();
    // A pointer move that presses nothing makes the window the virtual key window.
    await s.pointer(field.x, field.y, "move");
    await s.until("host.window", window => window.virtualKey, "the shortcut window did not become the virtual key window");
    await s.click(field.x, field.y);
    await s.until("host.window", window => window.responder?.surface === probe.surface,
      "the native field press did not focus its view");
    await s.until("probeinput.field", value => value.focused,
      "the view field did not report focus", { surface: probe.surface });
    const menu = await s.get("host.menu");
    const resetItem = menu.menus.flatMap(item => item.items).find(item => item.key === "cmd+0");
    assert.ok(resetItem, `the active menu has no Command+0 item: ${JSON.stringify(menu)}`);
    const beforeShortcut = await s.get("host.window");
    assert.equal(beforeShortcut.virtualKey, true, "the shortcut window is not the virtual key window");
    assert.equal(beforeShortcut.responder?.surface, probe.surface, "the probe view is not the first-responder owner");
    t.diagnostic(`before Command+0: window=${JSON.stringify(beforeShortcut)}`);
    t.diagnostic(`before Command+0: menu item=${JSON.stringify(resetItem)}`);
    await s.until("core.text", value => value.scope.kind === "card" && value.scope.card === card.id,
      "the view did not select its owning text-size scope");
    await s.run("core.text.larger");
    await s.until("core.text", value => value.cards[card.id] > 1, "text-size preparation did not apply");
    const original = (await s.get("probeinput.field", probe.surface)).value;
    t.diagnostic(`shortcut baseline=${JSON.stringify(original)}`);
    await s.press("0", { modifiers: ["command"] });
    await s.until("core.text", value => value.cards[card.id] === 1,
      "the view key equivalent did not reset its owning card text size");
    assert.equal((await s.get("probeinput.field", probe.surface)).value, original,
      "the native menu shortcut inserted text into the view");
    const { displayed } = await s.presented();
    const stopped = await recording.stop({ after: displayed + 100 });
    assert.deepEqual((await s.get("core.workbench.audit")).unbound, []);
    t.diagnostic(`native menu shortcut: ${recordingSummary(stopped)}`);
  });
}
