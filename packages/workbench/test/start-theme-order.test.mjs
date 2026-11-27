// A page start sends the theme of the stored settings before it places any surface, so a view that the first layout creates receives
// the stored theme (docs/spec/native-surfaces.md#view-surfaces).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { selectPageWire } from "@soksak/runtime";

const wire = selectPageWire("view-theme-card-session");
const settled = () => new Promise((resolve) => setImmediate(resolve));

test("a page start sends the stored theme before its first placement", { timeout: 5000 }, async () => {
  const dom = new JSDOM("<html></html>");
  globalThis.document = dom.window.document;
  try {
    const { beginSettings } = await import("../settings.js");
    beginSettings({ common: { mode: "dark" }, projects: [] }, null);
    // The host module sends its calls in turn after the current task.
    await settled();
    const names = wire.calls.map(({ name }) => name).filter((name) => name !== "log");
    const first = wire.calls.find(({ name }) => name === "setTheme");
    assert.ok(first, "the page start sent no theme");
    assert.equal(first.payload.scheme, "dark", "the first theme of the page start is not the stored mode");
    assert.equal(names.indexOf("setTheme"), 0, `the page start sent ${names.join(", ")} before its theme`);
    assert.equal(names.includes("syncSurfaces") && names.indexOf("syncSurfaces") < names.indexOf("setTheme"), false,
      "a surface was placed before the theme of the page start");
    wire.finish();
  } finally {
    dom.window.close();
    delete globalThis.document;
  }
});
