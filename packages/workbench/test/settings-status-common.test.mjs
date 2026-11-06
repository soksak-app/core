// core.settings reports the effective values and the common values apart: a setting that the selected project overrides has
// its project value in values and its stored common value in common, so a check that keeps the common settings reads the
// values that it restores (docs/spec/settings.md#reported-state).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("core.settings reports the common value of a setting that the project overrides", { timeout: 5000 }, async () => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const { beginSettings } = await import("../settings.js");
  const { installCoreExposure } = await import("../core-exposure.js");
  try {
    await installCoreExposure({ library: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {} });
    beginSettings({ common: { gap: 8 }, projects: [{ id: "prj-a", root: "/work/a", settings: { gap: 12 } }] }, "prj-a");
    const reply = await registry.handle({ method: "status.get", params: { name: "core.settings" } });
    assert.equal(reply.result.values.gap, 12, `effective values: ${JSON.stringify(reply)}`);
    assert.equal(reply.result.common?.gap, 8, `common values: ${JSON.stringify(reply.result.common)}`);
    assert.deepEqual(Object.keys(reply.result.common).sort(), Object.keys(reply.result.values).sort());
  } finally {
    dom.window.close();
  }
});
