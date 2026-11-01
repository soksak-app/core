// core.sidebar.section.fold and core.sidebar.section.select change the slots of the section surfaces: a folded section and the section of
// an unselected tab are hidden, and the other sections take its room. The commands lay out the plane again, so the compositor publishes
// the new seats and the host hides the view of the hidden section (docs/spec/plugins.md#sections).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("folding a section and selecting a section tab lay out the plane again", { timeout: 5000 }, async (t) => {
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

  const events = [];
  const actualPlane = await import("../plane.js");
  t.mock.module("../plane.js", { exports: { ...actualPlane, settle: () => { events.push("settle"); } } });
  const actualSections = await import("../sidebar-sections.js");
  t.mock.module("../sidebar-sections.js", { exports: { ...actualSections,
    foldSection: (sidebar, section) => { events.push(`fold ${sidebar} ${section}`); },
    selectSection: (sidebar, section) => { events.push(`select ${sidebar} ${section}`); },
  } });
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const { installCoreExposure } = await import("../core-exposure.js");
  try {
    await installCoreExposure({
      library: { state: () => null }, renames: { state: () => null }, chrome: () => null, drawn: async () => {},
    });
    await registry.run("core.sidebar.section.fold", { sidebar: "left", section: "files.bookmarks" });
    await registry.run("core.sidebar.section.select", { sidebar: "rail", section: "files.tree" });
    assert.deepEqual(events, ["fold left files.bookmarks", "settle", "select rail files.tree", "settle"],
      "a section choice did not lay out the plane again");
  } finally {
    dom.window.close();
  }
});
