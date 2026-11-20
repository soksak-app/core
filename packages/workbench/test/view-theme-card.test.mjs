// The theme that the page sends to the host for its views holds the card background of the theme as --card, the same for every surface,
// so each plugin paints the background of core; a group card changes no token of the surfaces inside it
// (docs/spec/native-surfaces.md#view-surfaces, docs/spec/groups.md#drawing).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const wire = selectPageWire("view-theme-card-session");

test("the theme of the views carries the card background of the theme as --card", { timeout: 5000 }, async () => {
  const dom = new JSDOM("<html></html>");
  globalThis.document = dom.window.document;
  try {
    const { beginSettings, THEMES, defaults } = await import("../settings.js");
    beginSettings({ common: {}, projects: [] }, null);
    // The host module sends its calls in turn after the current task.
    await new Promise((resolve) => setImmediate(resolve));
    const sent = wire.calls.filter(({ name }) => name === "setTheme").map(({ payload }) => payload);
    const theme = THEMES.find((item) => item.name === defaults.theme);
    assert.deepEqual(sent.map(({ scheme, tokens }) => ({ scheme, card: tokens["--card"] })),
      [{ scheme: defaults.mode, card: theme[defaults.mode].card }], "the theme of the views does not carry the card background");
    assert.equal(Object.hasOwn(sent[0], "surfaces"), false, "the theme of the views carries tokens of single surfaces");
    wire.finish();
  } finally {
    dom.window.close();
    delete globalThis.document;
  }
});
