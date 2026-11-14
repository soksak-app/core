import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("missing card sidebar links display off without an inherit option", async () => {
  const dom = new JSDOM("<body><div id=plane></div></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  // The loaded plugin is an installed manifest that the environment registers.
  const { installEnvironment } = await import("../environment.js");
  const surface = { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } };
  assert.deepEqual(installEnvironment({
    runtime: "runtime",
    workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [
      { id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "fixture", title: "Fixture" }] },
    ] } },
    sidebars: { sets: [], links: [] },
  }, { plugins: [{ id: "fixture", package: "@fixture/fixture", version: "1.0.0", manifest: {
    id: "fixture", name: "Fixture", description: "Fixture card.", mark: "f", icon: "<path/>", surface,
  } }] }), [], "the fixture environment refused a plugin");
  const { scopedValue } = await import("../settings.js");
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const ui = await import("../settings-ui.js");
  try {
    ui.openSettings();
    ui.showSection("plugins");
    ui.showPlugin("fixture");
    for (const side of ["left", "right", "top", "bottom"]) {
      const select = document.querySelector(`[data-set="link:card-${side}:fixture"]`);
      assert.ok(select, `card-${side} control is missing`);
      assert.equal(select.value, "off", `card-${side} displayed an unavailable inherited choice`);
      assert.equal(select.selectedOptions[0].textContent, "사용 안 함");
      assert.equal([...select.options].some((option) => option.value === "inherit"), false);
    }
    // An invalid value at the consumer boundary is not replaced with the first item of the browser. The settings refuse to hold a link to a set that
    // the sets lack, so the links and the sets are the data of the select box of the link.
    const sets = scopedValue("sets", "common");
    assert.throws(() => ui.linkChoice([{ place: "card-right", plugin: "fixture", set: "missing-set" }], sets, "link:card-right:fixture", "card-right", "fixture"),
      /unknown settings choice missing-set/);
    for (const set of [null, undefined]) {
      assert.throws(() => ui.linkChoice([{ place: "card-right", plugin: "fixture", set }], sets, "link:card-right:fixture", "card-right", "fixture"),
        /unknown settings choice/, `invalid card set ${String(set)} was coerced to off`);
    }
    ui.drawSettings();
    assert.equal(document.querySelector('[data-set="link:window-right:fixture"]').value, "off");
    assert.throws(() => ui.linkChoice([{ place: "window-right", plugin: "fixture", set: null }], sets, "link:window-right:fixture", "window-right", "fixture"),
      /unknown settings choice/);
  } finally {
    ui.closeSettings();
    dom.window.close();
  }
});
