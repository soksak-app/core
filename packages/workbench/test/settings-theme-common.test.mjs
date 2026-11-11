// core.settings.theme writes the theme and its shape values to the common scope when the request names no scope, also while a
// project is selected, as core.settings.theme of exposure.json declares; a request with scope project writes them to the project.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const THEME_KEYS = ["font", "gap", "mode", "radius", "size", "theme"];

test("core.settings.theme without a scope writes the common scope while a project is selected", { timeout: 5000 }, async () => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  const memory = { common: {}, projects: [{ id: "prj-a", root: "/work/a", settings: {} }] };
  const { beginSettings, connectSettings } = await import("../settings.js");
  await connectSettings({
    snapshot: async () => structuredClone(memory),
    settings: async (id, values) => {
      if (id) Object.assign(memory.projects.find((project) => project.id === id).settings, values);
      else memory.common = { ...memory.common, ...values };
    },
    onChange: () => () => {},
  });
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const { installCoreExposure } = await import("../core-exposure.js");
  const status = async () => (await registry.handle({ method: "status.get", params: { name: "core.settings" } })).result;
  try {
    await installCoreExposure({ library: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {} });
    beginSettings(structuredClone(memory), "prj-a");
    await registry.run("core.settings.theme", { name: "midnight", mode: "dark" });
    const after = await status();
    assert.deepEqual(after.overridden, [], `the project overrides ${JSON.stringify(after.overridden)}`);
    assert.equal(after.common.theme, "midnight");
    assert.equal(after.common.mode, "dark");
    assert.deepEqual(memory.projects[0].settings, {}, `the project file holds ${JSON.stringify(memory.projects[0].settings)}`);

    await registry.run("core.settings.theme", { name: "midnight", mode: "light", scope: "project" });
    const scoped = await status();
    assert.deepEqual([...scoped.overridden].sort(), THEME_KEYS);
    assert.equal(scoped.values.mode, "light");
    assert.equal(scoped.common.mode, "dark");
  } finally {
    dom.window.close();
  }
});
