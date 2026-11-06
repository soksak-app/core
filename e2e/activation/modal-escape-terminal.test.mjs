// Checks that the keyboard returns to the terminal after native Escape closes the add picker of the active key window, and
// that a key pressed as the picker opens does not reach the terminal. The terminal types its characters through the input
// method, which answers only the key window of the active application, so this check runs in the activation tier;
// e2e/modal-escape.test.mjs checks the Escape of the picker on the virtual key window.
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { echoed, ensureTerminals, readScreenUntil } from "../terminal-screen.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: the keyboard returns to the terminal after native Escape closes the add picker`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const [{ surface }] = await ensureTerminals(s, 1);
    await s.presented();
    const view = await s.rect("terminal.view", undefined, surface);
    const x = view.document.x + view.x + view.width / 2, y = view.document.y + view.y + view.height / 2;
    await s.pointer(x, y, "move", { activate: true });
    await s.selectInputSource("com.apple.keylayout.ABC");
    await s.click(x, y);
    await s.until("host.window", (state) => state.active && state.key && state.regions.some((region) =>
      region.surface === surface && region.focused), "the terminal did not take the keyboard");
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === surface)).id;
    await s.run("core.card.menu", { card, menu: "add" });
    await s.until("core.picker", (picker) => picker.open, "the add picker did not open");
    t.diagnostic(`picker open: ${JSON.stringify((await s.get("host.window")).responder)}`);
    const taken = await s.until("host.window", (state) => state.responder?.surface !== surface,
      "the keyboard stayed with the terminal behind the open add picker");
    t.diagnostic(`picker holds: ${JSON.stringify(taken.responder)}`);
    await s.press("Escape");
    await s.until("core.picker", (picker) => !picker.open, "native Escape did not close the add picker");
    await s.until("host.window", (state) => state.regions.some((region) => region.surface === surface && region.focused),
      "the keyboard did not return to the terminal");
    t.diagnostic(`picker closed: ${JSON.stringify((await s.get("host.window")).responder)}`);
    for (const ch of "echo modalback") await s.press(ch === " " ? "Space" : ch);
    await s.press("Enter");
    await readScreenUntil(s, surface, (lines) => echoed(lines, "modalback"), "the keys after the Escape did not reach the terminal");
  });
}

// A person can press a key as soon as the add picker opens, before its page has drawn. The key reaches the picker or nothing,
// and the terminal behind it reads only what follows the close.
for (const app of Object.values(APPS)) {
  for (const [name, key] of [["Escape", "Escape"], ["a character", "q"]]) {
    test(`${app.name}: ${name} pressed as the add picker opens does not reach the terminal`, async (t) => {
      const s = await open(t, app);
      await fresh(s);
      const [{ surface }] = await ensureTerminals(s, 1);
      await s.presented();
      const view = await s.rect("terminal.view", undefined, surface);
      const x = view.document.x + view.x + view.width / 2, y = view.document.y + view.y + view.height / 2;
      await s.pointer(x, y, "move", { activate: true });
      await s.selectInputSource("com.apple.keylayout.ABC");
      await s.click(x, y);
      await s.until("host.window", (state) => state.active && state.key && state.regions.some((region) =>
        region.surface === surface && region.focused), "the terminal did not take the keyboard");
      const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === surface)).id;
      await s.run("core.card.menu", { card, menu: "add" });
      await s.press(key);
      t.diagnostic(`after the key: ${JSON.stringify((await s.get("host.window")).responder)}`);
      if ((await s.get("core.picker")).open) {
        await s.until("host.window", (state) => state.responder?.surface !== surface,
          "the keyboard stayed with the terminal behind the open add picker");
        await s.press("Escape");
        await s.until("core.picker", (picker) => !picker.open, "native Escape did not close the add picker");
      }
      await s.until("host.window", (state) => state.regions.some((region) => region.surface === surface && region.focused),
        "the keyboard did not return to the terminal");
      for (const ch of "echo modalleak") await s.press(ch === " " ? "Space" : ch);
      await s.press("Enter");
      await readScreenUntil(s, surface, (lines) => echoed(lines, "modalleak"), "the key pressed as the picker opened reached the terminal");
    });
  }
}
