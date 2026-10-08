// core.space.close asks for each modified tab of the window before it removes the active space
// (docs/spec/plugins.md#tab-reports).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("core.space.close asks about modified tabs before it removes the active space", { timeout: 5000 }, async (t) => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true,
    addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);

  // The order of the question and the removal; the person keeps the tabs while kept is true.
  const events = [];
  let kept = false;
  const actualPlane = await import("../plane.js");
  t.mock.module("../plane.js", { exports: { ...actualPlane,
    settleModifiedTabsToClose: async () => { events.push("ask"); return !kept; },
  } });
  const actualProjects = await import("../projects.js");
  const project = { activeSpaceId: "spc-a", spaces: [{ id: "spc-a" }, { id: "spc-b" }] };
  t.mock.module("../projects.js", { exports: { ...actualProjects,
    active: () => project,
    closeSpace: (id) => { events.push(`close ${id}`); },
  } });
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const { installCoreExposure } = await import("../core-exposure.js");
  try {
    await installCoreExposure({
      library: { state: () => null }, renames: { state: () => null }, chrome: () => null,
      drawn: async () => {},
    });
    assert.deepEqual(await registry.run("core.space.close", { id: "spc-a" }), { closed: true });
    assert.deepEqual(events, ["ask", "close spc-a"], "the active space was removed without the question");
    // A kept tab keeps the space.
    events.length = 0;
    kept = true;
    assert.deepEqual(await registry.run("core.space.close", { id: "spc-a" }), { closed: false });
    assert.deepEqual(events, ["ask"]);
    // Another space has no modified tab in the plane, so it closes without a question.
    events.length = 0;
    assert.deepEqual(await registry.run("core.space.close", { id: "spc-b" }), { closed: true });
    assert.deepEqual(events, ["close spc-b"]);
  } finally {
    dom.window.close();
  }
});
