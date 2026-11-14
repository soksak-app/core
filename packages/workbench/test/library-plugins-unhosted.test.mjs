import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { installExposure } from "../exposure.js";
import exposureFile from "../exposure.json" with { type: "json" };

installExposure(exposureFile);

// A window without a native host shows the plugins that it loaded and offers no operation buttons (docs/spec/installation.md). The runtime of
// the workbench tests has no host until a test selects a page-wire case, so this window has none.
test("the plugin page of a window without a host lists the loaded plugin and offers no operations", async () => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8")
    .replace("</body>", "<div id=library></div></body>");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.devicePixelRatio = dom.window.devicePixelRatio;
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.CSS = dom.window.CSS;
  globalThis.PointerEvent = dom.window.PointerEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  const { installEnvironment } = await import("../environment.js");
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "tty", title: "t" }] }] } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [{ id: "tty", package: "@scope/tty", version: "0.1.0", manifest: {
    id: "tty", name: "터미널", description: "명령을 실행하는 표면.", mark: "t", icon: "<path/>",
    surface: { composition: { kind: "view", page: "ui/index.html" } },
  } }] }), [], "the fixture environment refused a plugin");
  const { createLibrary } = await import("../library.js");
  const root = document.getElementById("library");
  const library = createLibrary(root);
  try {
    await library.actions.page("plugins");
    library.render();
    assert.ok(root.querySelector('.library-plugin[data-plugin-id="tty"]'), "the loaded plugin has no card");
    assert.deepEqual([...root.querySelectorAll('.library-plugin[data-plugin-id="tty"] [data-expose="core.library.plugins.action"]')], []);
  } finally {
    dom.window.close();
  }
});
