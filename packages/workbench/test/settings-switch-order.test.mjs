// The press of a window sidebar switch applies the value in its own turn: the listeners that draw the plane run before the host
// writes the settings, and the change answers once the host wrote them (docs/spec/external-sidebars.md#window-controls).
import assert from "node:assert/strict";
import test from "node:test";

test("a switch reaches the drawing before the settings write, and answers after the write", async () => {
  const realDocument = globalThis.document;
  globalThis.document = { addEventListener: () => {}, documentElement: { dataset: {}, style: { setProperty() {} } } };
  const memory = { common: {}, projects: [] };
  const order = [];
  let answer = null;
  let writeStarted = null;
  const written = new Promise((resolve) => { writeStarted = resolve; });
  const { connectSettings, onSettingsChange, set: change, value } = await import("../settings.js?test=switch-order");
  try {
    await connectSettings({
      snapshot: async () => structuredClone(memory),
      settings: (id, values) => {
        order.push(`write ${JSON.stringify(values)}`);
        writeStarted();
        return new Promise((resolve) => { answer = () => { memory.common = { ...memory.common, ...values }; resolve(); }; });
      },
      onChange: () => () => {},
    });
    onSettingsChange(() => order.push(`draw left ${value("left")}`));
    let answered = false;
    const pending = change({ left: false }, "common", "core.settings.set").then(() => { answered = true; });
    assert.deepEqual(order, ["draw left false"], "the change reached the drawing after the write started");
    // The write starts after the snapshot is read, and the settings mock reports its start.
    await written;
    assert.deepEqual(order, ["draw left false", 'write {"left":false}']);
    assert.equal(answered, false, "the change answered before the host wrote the settings");
    answer();
    await pending;
    assert.equal(answered, true);
  } finally {
    globalThis.document = realDocument;
  }
});
