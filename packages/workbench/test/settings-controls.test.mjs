import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

// 설정 창은 설정의 형식마다 정해진 컨트롤 하나로 그린다(docs/spec/settings.md 의 Controls).
test("every setting form is drawn with its one control", async (t) => {
  const dom = new JSDOM("<body><div id=plane></div></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.CSS = dom.window.CSS ?? { escape: (text) => text };
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  t.mock.module("../compositor.js", { exports: {
    ...await import("../compositor.js"), standIn: () => {},
  } });
  t.mock.module("../environment.js", { exports: { pluginUnits: () => [
    { id: "fixture", name: "Fixture", description: "Fixture card.", version: "1.0.0", surface: true, sections: [], sidecars: [] },
  ] } });
  const settings = await import("../settings.js");
  settings.setPluginSettings([{ id: "fixture", settings: {
    shape: { label: "모양", type: "enum", values: ["block", "underline", "beam"], default: "block" },
    columns: { label: "열", type: "integer", minimum: 20, maximum: 400, default: 80 },
    family: { label: "글꼴", type: "string", maxLength: 40, default: "Menlo" },
    home: { label: "홈 주소", type: "address", default: "" },
  } }]);
  const sets = [{ id: "set-1", title: "탐색기", sections: [], layout: "list" }];
  t.mock.module("../settings.js", { exports: {
    ...settings, scopedValue: (key, scope) => key === "sets" ? sets : key === "links" ? [] : settings.scopedValue(key, scope),
  } });
  const { registry } = await import("../exposure.js");
  registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
  const ui = await import("../settings-ui.js");
  /** 설정 키의 컨트롤: 태그, 입력 종류, 명령 이름과 선택 상자의 값. */
  const controlOf = (key) => {
    const control = ui.settingsModalState().controls.find((item) => item.key === key);
    assert.ok(control, `no control for ${key}`);
    const el = document.querySelector(`[data-set="${key}"]`);
    return { tag: el.tagName, type: el.type, command: control.command.name, options: control.options };
  };
  try {
    ui.openSettings();
    ui.showSection("general");
    // 선택지는 값이 몇 개든 선택 상자다. 단추를 늘어놓는 선택지는 없다.
    for (const key of ["projectOpening", "mode", "font", "projectTabs", "focusInd", "fullRule", "language"]) {
      const control = controlOf(key);
      assert.deepEqual([control.tag, control.command], ["SELECT", "core.settings.change"], `${key} is not a select box`);
      assert.equal(document.querySelector(`[data-set="${key}"]`).value, settings.scopedValue(key, "common"));
    }
    assert.deepEqual(controlOf("mode").options, settings.CHOICES.mode);
    assert.deepEqual(controlOf("fullRule").options, settings.CHOICES.fullRule);
    assert.equal(document.querySelectorAll('[data-key^="pick:"]:not([data-expose="core.settings-modal.scope"])').length, 0,
      "a choice is drawn as buttons");
    for (const key of ["left", "right", "dim"]) assert.equal(controlOf(key).type, "checkbox", `${key} is not a switch`);
    for (const key of ["gap", "radius", "size", "sidebarMinWidth", "sidebarMaxWidth", "sidebarWidth"]) {
      assert.equal(controlOf(key).type, "range", `${key} is not a slider`);
    }
    assert.equal(controlOf("link:left:").tag, "SELECT");
    assert.equal(document.querySelectorAll('[data-expose="core.settings-modal.theme"]').length, settings.THEMES.length);

    ui.showSection("plugins");
    ui.showPlugin("fixture");
    assert.deepEqual(controlOf("fixture.shape"), { tag: "SELECT", type: "select-one", command: "core.settings.change",
      options: ["block", "underline", "beam"] });
    assert.equal(controlOf("fixture.columns").type, "range");
    assert.equal(controlOf("fixture.family").type, "text");
    assert.equal(controlOf("fixture.home").type, "text");

    ui.showSection("sidebars");
    ui.editSet("set-1");
    const layout = ui.settingsModalState().controls.find((item) => item.key === "layout:set-1");
    assert.deepEqual([layout?.name, layout?.value, layout?.options, layout?.command],
      ["core.settings-modal.set", "list", ["list", "tabs"], { name: "core.settings.sets.update", params: { id: "set-1", scope: "common" } }]);
    assert.equal(document.querySelector('[data-set="layout:set-1"]').dataset.value, "layout");
  } finally {
    ui.closeSettings();
    dom.window.close();
  }
});
