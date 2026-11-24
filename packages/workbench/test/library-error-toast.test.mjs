import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import exposureFile from "../exposure.json" with { type: "json" };

test("the project form uses the shared error toast when its folder is empty", async () => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(markup, { url: "http://localhost/" });
  try {
    dom.window.matchMedia = (query) => ({ media: query, matches: true, addEventListener() {}, removeEventListener() {} });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    // The page reads the start address of the window (docs/spec/installation.md#applying-a-change, F1149-1).
    globalThis.location = dom.window.location;
    globalThis.devicePixelRatio = dom.window.devicePixelRatio;
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    const { installExposure } = await import("../exposure.js");
    const { installEnvironment } = await import("../environment.js");
    const { begin } = await import("../projects.js");
    const { createLibrary } = await import("../library.js");
    installExposure(exposureFile);
    assert.deepEqual(installEnvironment({
      runtime: "runtime",
      workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: "fixture-note", title: "Note" }] } } },
      sidebars: { sets: [], links: [] },
    }, { plugins: [{ id: "fixture-note", package: "@fixture/note", version: "0.0.1", folder: "/installed/plugin", manifest: {
      id: "fixture-note", name: "Note", description: "Shows a note.", mark: "n", icon: "<path/>",
      surface: { composition: { kind: "view", page: "ui/index.html" } },
    } }] }), []);
    begin({ common: {}, projects: [], open: [] });
    const library = createLibrary(document.getElementById("library"));
    library.actions.openForm("open");
    await library.actions.submitForm();

    const message = "Project directory is empty";
    assert.equal(library.state().error, message);
    assert.equal(document.querySelector(".error-toast__text")?.textContent, message);
    assert.ok(document.querySelector('.error-toast [data-expose="core.error.dismiss"]'));
    assert.equal(document.querySelector(".library-error"), null);
  } finally {
    dom.window.close();
  }
});
