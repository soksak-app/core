import assert from "node:assert/strict";

/** Runs each reference key, reads its document, and checks it before starting the next key. */
export async function runReferenceSteps(keys, { press, read, verify, presented }) {
  for (const [index, key] of keys.entries()) {
    await press(key, index);
    const state = await read(key, index);
    await verify(state, key, index);
    await presented(key, index);
  }
}

export async function compareAppKitReference(s, keys, expected, expectedDocuments) {
  assert.ok(Array.isArray(expectedDocuments) && expectedDocuments.length === keys.length,
    "reference input requires one expected document per step");
  assert.equal(expectedDocuments.at(-1), expected, "the final reference step differs from the expected document");
  const window = s.window;
  await s.request("diagnostics.input.reference", { window, action: "open" });
  s.cleanup(() => s.request("diagnostics.input.reference", { window, action: "close" }));
  await s.request("diagnostics.input.reference", { window, action: "focus" });
  await runReferenceSteps(keys, {
    async press(step) {
      if (typeof step === "string") await s.press(step);
      else if (step.source) {
        assert.equal((await s.request("diagnostics.input.source", { select: step.source })).current, step.source);
      } else await s.press(step.key);
    },
    read: () => s.request("diagnostics.input.reference", { window, action: "read" }),
    verify(state, key, index) {
      console.info(`reference input ${index + 1}: ${JSON.stringify({ key, state, expected: expectedDocuments[index] })}`);
      assert.equal(state.open, true, "the same-window AppKit reference closed during input");
      assert.equal(state.focused, true, "the same-window AppKit reference lost focus during input");
      assert.equal(typeof state.document, "string", "the AppKit reference document is not text");
      assert.equal(state.document, expectedDocuments[index],
        `reference input ${index + 1} produced an unexpected AppKit document`);
    },
    presented: () => s.presented(),
  });
  const reference = await s.request("diagnostics.input.reference", { window, action: "wait", document: expected });
  assert.equal(reference.document, expected, "the AppKit reference document differs from the expected text");
  assert.equal(reference.marked, null, "the AppKit reference still has marked text after the sequence");
  assert.deepEqual(reference.selected, { location: expected.length, length: 0 },
    "the AppKit reference selection is not at the expected document end");
  await s.request("diagnostics.input.reference", { window, action: "close" });
}
