// Checks a native menu key equivalent from a focused plugin view. The window takes the press and the key as the virtual key
// window, and the key equivalent reaches the menu through the same path as in the key window of the active application, so the
// application and the input source of the person stay as they are (docs/spec/exposure.md#virtual-key-window).
import assert from "node:assert/strict";
import test from "node:test";
import { APPS, keepCommonSettings, open } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { fresh } from "./fixture.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: Command-zero in a focused view runs the native text-size menu command`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, {
      log: { input: "info", lifecycle: "info", call: "debug" },
      reads: ["native.input.key_down", "native.record.info", "native.window.first_responder", "workbench.command"],
    });
    await keepCommonSettings(s);
    const browser = (await s.get("core.surfaces")).find(item => item.plugin === "browser" && item.visible);
    assert.ok(browser, "the fixture has no visible browser view");
    await s.until("core.surfaces", all => all.some(item => item.surface === browser.surface
      && item.exposes.includes("status browser.address.text") && item.exposes.includes("element browser.address")),
    "the browser did not register its address field");
    const card = (await s.get("core.grid")).cards.find(item => item.tabs.some(tab => tab.id === browser.surface));
    assert.ok(card, "the browser has no owning card");
    const field = await s.rect("browser.address", undefined, browser.surface);
    const recording = await s.record();
    // A pointer move that presses nothing makes the window the virtual key window.
    await s.pointer(field.x + field.width / 2, field.y + field.height / 2, "move");
    await s.until("host.window", window => window.virtualKey, "the shortcut window did not become the virtual key window");
    await s.click(field.x + field.width / 2, field.y + field.height / 2);
    await s.until("host.window", window => window.responder?.surface === browser.surface,
      "the native address press did not focus its view");
    await s.until("browser.address.text", value => value.focused,
      "the address control did not report focus", { surface: browser.surface });
    const menu = await s.get("host.menu");
    const resetItem = menu.menus.flatMap(item => item.items).find(item => item.key === "cmd+0");
    assert.ok(resetItem, `the active menu has no Command+0 item: ${JSON.stringify(menu)}`);
    const beforeShortcut = await s.get("host.window");
    assert.equal(beforeShortcut.virtualKey, true, "the shortcut window is not the virtual key window");
    assert.equal(beforeShortcut.responder?.surface, browser.surface, "the browser view is not the first-responder owner");
    t.diagnostic(`before Command+0: window=${JSON.stringify(beforeShortcut)}`);
    t.diagnostic(`before Command+0: menu item=${JSON.stringify(resetItem)}`);
    await s.until("core.text", value => value.scope.kind === "card" && value.scope.card === card.id,
      "the view did not select its owning text-size scope");
    await s.run("core.text.larger");
    await s.until("core.text", value => value.cards[card.id] > 1, "text-size preparation did not apply");
    const original = (await s.get("browser.address.text", browser.surface)).value;
    t.diagnostic(`shortcut baseline=${JSON.stringify(original)}`);
    await s.press("0", { modifiers: ["command"] });
    await s.until("core.text", value => value.cards[card.id] === 1,
      "the view key equivalent did not reset its owning card text size");
    assert.equal((await s.get("browser.address.text", browser.surface)).value, original,
      "the native menu shortcut inserted text into the view");
    const { displayed } = await s.presented();
    const stopped = await recording.stop({ after: displayed + 100 });
    const captured = frames(recording.frames).map(readFrame);
    assert.equal(captured.length, stopped.count, "the shortcut gesture has missing frame files");
    assert.ok(captured.length > 1, "the shortcut gesture has no complete recording");
    assert.equal(stopped.limited, false, "the shortcut gesture exceeded its recording capacity");
    assert.deepEqual((await s.get("core.workbench.audit")).unbound, []);
    t.diagnostic(`native menu shortcut: ${captured.length} frames, gap ${stopped.longestGap}ms`);
  });
}
