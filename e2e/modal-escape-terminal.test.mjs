// Checks that the keyboard returns to the terminal after native Escape closes the add picker of the key window, and that a key
// pressed as the picker opens does not reach the terminal. The window takes the press and the keys as the virtual key window and
// each character key states its text, so the application and the input source of the person stay as they are
// (docs/spec/exposure.md#virtual-key-window); e2e/modal-escape.test.mjs checks the Escape of the picker itself.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { fresh } from "./fixture.mjs";
import { echoed, ensureTerminals, readScreenUntil } from "./terminal-screen.mjs";

// Presses each character of text with that text stated, and a space as Space.
async function type(s, text) {
  for (const ch of text) await s.press(ch === " " ? "Space" : ch, { text: ch });
}

// Makes the window the virtual key window over the terminal, presses the terminal and waits until it holds the keyboard.
async function focusTerminal(s, surface) {
  const view = await s.rect("terminal.view", undefined, surface);
  const x = view.document.x + view.x + view.width / 2, y = view.document.y + view.y + view.height / 2;
  // A pointer move that presses nothing makes the window the virtual key window.
  await s.pointer(x, y, "move");
  await s.until("host.window", (state) => state.virtualKey, "the window did not become the virtual key window");
  await s.click(x, y);
  await s.until("host.window", (state) => state.virtualKey && state.regions.some((region) =>
    region.surface === surface && region.focused), "the terminal did not take the keyboard");
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the keyboard returns to the terminal after native Escape closes the add picker`, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const [{ surface }] = await ensureTerminals(s, 1);
    await s.presented();
    await focusTerminal(s, surface);
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
    await type(s, "echo modalback");
    await s.press("Enter");
    await readScreenUntil(s, surface, (lines) => echoed(lines, "modalback"), "the keys after the Escape did not reach the terminal");
  });
}

// The injection records of the native input of the key after offsets: the first responder, whether the key waited behind the held
// input of the window and the result of each phase (docs/spec/exposure.md#virtual-key-window).
async function keyRecords(s, offsets, key) {
  await s.flushLog();
  return readEvents(s.app.configDir, offsets).events
    .filter((event) => event.event === "native.record.info" && event.fields?.where === "input inject")
    .map((event) => JSON.parse(event.fields.text)).filter((record) => record.kind === "key" && record.key === key);
}

// A person can press a key as soon as the add picker opens, before its page has drawn. The key waits for the picker and reaches
// it, never the terminal behind it: Escape closes the picker by itself, and a character leaves it open for the Escape that the
// check presses once the picker holds the keyboard (docs/spec/native-modals.md#keyboard). The terminal reads only what follows
// the close. A failure states the injection records of the key.
for (const app of Object.values(APPS)) {
  for (const [name, key, options] of [["Escape", "Escape", {}], ["a character", "q", { text: "q" }]]) {
    test(`${app.name}: ${name} pressed as the add picker opens does not reach the terminal`, async (t) => {
      const s = await open(t, app);
      await fresh(s, { log: { input: "info", lifecycle: "info" }, reads: ["native.record.info"] });
      const [{ surface }] = await ensureTerminals(s, 1);
      await s.presented();
      await focusTerminal(s, surface);
      const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === surface)).id;
      await s.run("core.card.menu", { card, menu: "add" });
      const offsets = currentEventOffsets(s.app.configDir);
      await s.press(key, options);
      t.diagnostic(`after the key: ${JSON.stringify((await s.get("host.window")).responder)}`);
      if (key === "Escape") {
        // A second Escape would race the close that this one causes: once the keyboard returns to the terminal it reaches it.
        await s.until("core.picker", (picker) => !picker.open, "the Escape pressed as the add picker opened did not close it");
        const records = await keyRecords(s, offsets, key);
        const down = records.filter((record) => record.down);
        assert.equal(down.length, 1, `the Escape has one key down record: ${JSON.stringify(records)}`);
        assert.notEqual(down[0].responder, "SPImageRegion", `the Escape reached the terminal: ${JSON.stringify(records)}`);
      } else if ((await s.get("core.picker")).open) {
        await s.until("host.window", (state) => state.responder?.surface !== surface,
          "the keyboard stayed with the terminal behind the open add picker");
        await s.press("Escape");
        await s.until("core.picker", (picker) => !picker.open, "native Escape did not close the add picker");
      }
      await s.until("host.window", (state) => state.regions.some((region) => region.surface === surface && region.focused),
        "the keyboard did not return to the terminal");
      await type(s, "echo modalleak");
      await s.press("Enter");
      try {
        await readScreenUntil(s, surface, (lines) => echoed(lines, "modalleak"), "the key pressed as the picker opened reached the terminal");
      } catch (error) {
        error.message = `key records ${JSON.stringify(await keyRecords(s, offsets, key))}; ${error.message}`;
        throw error;
      }
    });
  }
}
