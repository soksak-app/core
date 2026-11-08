// Checks that the keyboard returns to the document region of a view after native Escape closes the add picker of the key window,
// and that a key pressed as the picker opens does not reach that region. The document region of the input probe reports each key
// that reaches it. The window takes the press and the keys as the virtual key window and
// each character key states its text, so the application and the input source of the person stay as they are
// (docs/spec/exposure.md#virtual-key-window); e2e/modal-escape.test.mjs checks the Escape of the picker itself.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { currentEventOffsets, readEvents } from "@soksak/window-check/event-log.mjs";
import { fresh } from "./fixture.mjs";
import { documentFocused, documentPoint, inputProbeTab, typeText } from "./input-probe.mjs";

// Makes the window the virtual key window over the probe document, presses it and waits until it holds the keyboard.
async function focusDocument(s, surface) {
  const { x, y } = await documentPoint(s, surface);
  // A pointer move that presses nothing makes the window the virtual key window.
  await s.pointer(x, y, "move");
  await s.until("host.window", (state) => state.virtualKey, "the window did not become the virtual key window");
  await s.click(x, y);
  await s.until("host.window", (state) => state.virtualKey && documentFocused(state, surface),
    "the probe document did not take the keyboard");
}

// The keys down that reached the probe document after the key `after`, as their names.
async function keysAfter(s, surface, after) {
  return (await s.get("probeinput.document", surface)).keys.filter((key) => key.sequence > after && key.type === "keydown")
    .map((key) => key.key);
}

// Waits until the probe document holds `text` after the key `after` typed it, and returns the names of the keys down since.
async function typedAfter(s, surface, after, text, message) {
  await s.until("probeinput.document", (state) => state.value.endsWith(text) && state.keys.some((key) => key.sequence > after),
    message, { surface });
  return keysAfter(s, surface, after);
}

// The sequence of the last key of the probe document.
const lastKey = async (s, surface) => (await s.get("probeinput.document", surface)).keys.at(-1)?.sequence ?? 0;

for (const app of Object.values(APPS)) {
  test(`${app.name}: the keyboard returns to the document region after native Escape closes the add picker`, async (t) => {
    const s = await open(t, app, { inactive: true });
    await fresh(s);
    const { surface } = await inputProbeTab(s);
    await s.presented();
    await focusDocument(s, surface);
    const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === surface)).id;
    await s.run("core.card.menu", { card, menu: "add" });
    await s.until("core.picker", (picker) => picker.open, "the add picker did not open");
    t.diagnostic(`picker open: ${JSON.stringify((await s.get("host.window")).responder)}`);
    const taken = await s.until("host.window", (state) => state.responder?.surface !== surface,
      "the keyboard stayed with the probe document behind the open add picker");
    t.diagnostic(`picker holds: ${JSON.stringify(taken.responder)}`);
    const before = await lastKey(s, surface);
    await s.press("Escape");
    await s.until("core.picker", (picker) => !picker.open, "native Escape did not close the add picker");
    await s.until("host.window", (state) => documentFocused(state, surface), "the keyboard did not return to the probe document");
    t.diagnostic(`picker closed: ${JSON.stringify((await s.get("host.window")).responder)}`);
    await typeText(s, "modalback");
    const keys = await typedAfter(s, surface, before, "modalback", "the keys after the Escape did not reach the probe document");
    assert.deepEqual(keys, [..."modalback"], "the probe document received a key other than those typed after the Escape");
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
// it, never the probe document behind it: Escape closes the picker by itself, and a character leaves it open for the Escape that
// the check presses once the picker holds the keyboard (docs/spec/native-modals.md#keyboard). The document receives only what
// follows the close. A failure states the injection records of the key.
for (const app of Object.values(APPS)) {
  for (const [name, key, options] of [["Escape", "Escape", {}], ["a character", "q", { text: "q" }]]) {
    test(`${app.name}: ${name} pressed as the add picker opens does not reach the document region`, async (t) => {
      const s = await open(t, app, { inactive: true });
      await fresh(s, { log: { input: "info", lifecycle: "info" }, reads: ["native.record.info"] });
      const { surface } = await inputProbeTab(s);
      await s.presented();
      await focusDocument(s, surface);
      const card = (await s.get("core.grid")).cards.find((item) => item.tabs.some((tab) => tab.id === surface)).id;
      await s.run("core.card.menu", { card, menu: "add" });
      const before = await lastKey(s, surface);
      const offsets = currentEventOffsets(s.app.configDir);
      await s.press(key, options);
      t.diagnostic(`after the key: ${JSON.stringify((await s.get("host.window")).responder)}`);
      if (key === "Escape") {
        // A second Escape would race the close that this one causes: once the keyboard returns to the probe document it reaches it.
        await s.until("core.picker", (picker) => !picker.open, "the Escape pressed as the add picker opened did not close it");
        const records = await keyRecords(s, offsets, key);
        const down = records.filter((record) => record.down);
        assert.equal(down.length, 1, `the Escape has one key down record: ${JSON.stringify(records)}`);
        assert.deepEqual(await keysAfter(s, surface, before), [], `the Escape reached the probe document: ${JSON.stringify(records)}`);
      } else if ((await s.get("core.picker")).open) {
        await s.until("host.window", (state) => state.responder?.surface !== surface,
          "the keyboard stayed with the probe document behind the open add picker");
        await s.press("Escape");
        await s.until("core.picker", (picker) => !picker.open, "native Escape did not close the add picker");
      }
      await s.until("host.window", (state) => documentFocused(state, surface), "the keyboard did not return to the probe document");
      await typeText(s, "modalleak");
      try {
        const keys = await typedAfter(s, surface, before, "modalleak", "the keys after the close did not reach the probe document");
        assert.deepEqual(keys, [..."modalleak"], "the key pressed as the picker opened reached the probe document");
      } catch (error) {
        error.message = `key records ${JSON.stringify(await keyRecords(s, offsets, key))}; ${error.message}`;
        throw error;
      }
    });
  }
}
