// Escape in an open native menu answers with the declared command core.modal.dismiss, and the answer runs that command through the registry.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<body><div id="menu" data-native-modal="menu" aria-label="Menu"></div></body>', { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

const { registry } = await import("../exposure.js");
const { run } = await import("../commands.js");
const { onAnswer } = await import("../card.js");

registry.declare("core", {
  status: [],
  commands: [
    { name: "core.modal.dismiss", description: "Dismisses the open native menu.", params: { type: "object", properties: {} }, result: { type: "null" } },
  ],
  dom: [],
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("Escape in an open native menu answers core.modal.dismiss and the answer runs that command through the registry", async () => {
  const calls = [];
  registry.command("core.modal.dismiss", () => { calls.push("dismiss"); });
  const answers = [];
  onAnswer(document, (key, value) => { answers.push([key, value]); });
  document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.deepEqual(answers, [["core.modal.dismiss", ""]]);
  // The receiver of a native picker runs the answered command with the registry run of the page.
  const { pickerAnswer } = await import("../picker-layer.js");
  pickerAnswer(["a:t1"], run)(answers[0][0]);
  await settle();
  assert.deepEqual(calls, ["dismiss"]);
});

test("an answer that names no item of the picker and no dismiss command is refused", async () => {
  const { pickerAnswer } = await import("../picker-layer.js");
  assert.throws(() => pickerAnswer(["a:t1"], run)("missing:key"), /is not an item of the menu/);
});
