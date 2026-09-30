import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

test("missing card sidebar links display off without an inherit option", async (t) => {
  const dom = new JSDOM("<body><div id=plane></div></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  t.mock.module("../compositor.js", { exports: {
    ...await import("../compositor.js"), standIn: () => {},
  } });
  t.mock.module("../environment.js", { exports: { pluginUnits: () => [
    { id: "fixture", name: "Fixture", description: "Fixture card.", surface: true, sections: [] },
  ] } });
  const settings = await import("../settings.js");
  let links = [];
  t.mock.module("../settings.js", { exports: {
    ...settings, scopedValue: (key, scope) => key === "links" ? links : settings.scopedValue(key, scope),
  } });
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
    // 유효하지 않은 소비자 경계 값을 브라우저의 첫 항목으로 바꾸지 않는다.
    links = [{ place: "card-right", plugin: "fixture", set: "missing-set" }];
    assert.throws(() => ui.drawSettings(), /unknown settings choice missing-set/);
    for (const set of [null, undefined]) {
      links = [{ place: "card-right", plugin: "fixture", set }];
      assert.throws(() => ui.drawSettings(), /unknown settings choice/, `invalid card set ${String(set)} was coerced to off`);
    }
    links = [{ place: "right", plugin: "fixture", set: null }];
    ui.drawSettings();
    assert.equal(document.querySelector('[data-set="link:right:fixture"]').value, "off",
      "a declared window-sidebar off choice must remain valid");
  } finally {
    ui.closeSettings();
    dom.window.close();
  }
});
