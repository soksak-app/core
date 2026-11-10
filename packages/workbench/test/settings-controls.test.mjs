import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

// The settings window draws each setting format with one fixed control (Controls in docs/spec/settings.md).
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
  /** The control of a setting key: the tag, the input kind, the command name, and the value of the select box. */
  const controlOf = (key) => {
    const control = ui.settingsModalState().controls.find((item) => item.key === key);
    assert.ok(control, `no control for ${key}`);
    const el = document.querySelector(`[data-set="${key}"]`);
    return { tag: el.tagName, type: el.type, command: control.command.name, options: control.options };
  };
  try {
    ui.openSettings();
    ui.showSection("general");
    // A choice is a select box regardless of how many values it has. There is no choice that lays out buttons.
    for (const key of ["projectOpening", "mode", "font", "projectTabs", "focusInd", "fullRule", "language"]) {
      const control = controlOf(key);
      assert.deepEqual([control.tag, control.command], ["SELECT", "core.settings.change"], `${key} is not a select box`);
      assert.equal(document.querySelector(`[data-set="${key}"]`).value, settings.scopedValue(key, "common"));
    }
    assert.deepEqual(controlOf("mode").options, settings.CHOICES.mode);
    assert.deepEqual(controlOf("fullRule").options, settings.CHOICES.fullRule);
    assert.equal(document.querySelectorAll('[data-key^="pick:"]:not([data-expose="core.settings-modal.scope"])').length, 0,
      "a choice is drawn as buttons");
    for (const key of ["left", "right", "top", "bottom", "dim"]) assert.equal(controlOf(key).type, "checkbox", `${key} is not a switch`);
    for (const key of ["gap", "radius", "size", "sidebarMinWidth", "sidebarMaxWidth", "sidebarWidth"]) {
      assert.equal(controlOf(key).type, "range", `${key} is not a slider`);
    }
    // The memory group of the common scope: a switch and a slider of minutes between the bounds of the setting.
    assert.equal(controlOf("memorySaver").type, "checkbox");
    const delay = document.querySelector('[data-set="memorySaverDelay"]');
    assert.deepEqual([controlOf("memorySaverDelay").type, delay.min, delay.max, delay.nextSibling.textContent],
      ["range", "5", "720", "120분"]);
    assert.equal(controlOf("link:left:").tag, "SELECT");
    for (const side of ["right", "top", "bottom"]) assert.equal(controlOf(`link:${side}:`).tag, "SELECT", `${side} has no set select`);
    // The order of the window sidebars: one row per side with ▲ (not on the first row) and ▼ (not on the last row), each running
    // core.settings.change with the whole new order (docs/spec/settings.md#controls).
    const order = ui.settingsModalState().controls.filter((item) => item.name === "core.settings-modal.order");
    assert.deepEqual(order.map((item) => item.key), ["order:sidebarOrder:0:down", "order:sidebarOrder:1:up", "order:sidebarOrder:1:down",
      "order:sidebarOrder:2:up", "order:sidebarOrder:2:down", "order:sidebarOrder:3:up"]);
    assert.deepEqual(order[0].command, { name: "core.settings.change", params: { key: "sidebarOrder", value: ["right", "left", "top", "bottom"], scope: "common" } });
    assert.deepEqual(order[5].command.params.value, ["left", "right", "bottom", "top"]);
    // Each order row shows the name of its value before its buttons, and the first row shows the name of the setting.
    const orderRows = [...document.querySelectorAll(".set-row")].filter((item) => item.querySelector('[data-expose="core.settings-modal.order"]'));
    assert.deepEqual(orderRows.map((item) => item.querySelector(".set-row__name").textContent), ["사이드바 순서", "", "", ""]);
    assert.deepEqual(orderRows.map((item) => item.querySelector(".set-row__name").nextElementSibling.firstChild.textContent),
      ["왼쪽", "오른쪽", "위", "아래"]);
    const group = [...document.querySelectorAll(".set-group")].find((item) => item.textContent.includes("사이드바 순서"));
    assert.ok(group?.textContent.includes("한 변에는 고정 사이드바가 하나 있고"), "the sidebar group does not state one fixed sidebar per side");
    assert.ok(!group.textContent.includes("독립된 열"), "the sidebar group still states independent columns");
    assert.equal(document.querySelectorAll('[data-expose="core.settings-modal.theme"]').length, settings.THEMES.length);

    ui.showSection("plugins");
    ui.showPlugin("fixture");
    assert.deepEqual(controlOf("fixture.shape"), { tag: "SELECT", type: "select-one", command: "core.settings.change",
      options: ["block", "underline", "beam"] });
    assert.equal(controlOf("fixture.columns").type, "range");
    assert.equal(controlOf("fixture.family").type, "text");
    assert.equal(controlOf("fixture.home").type, "text");
    // A text control fills its row as every text field does (.text-field in app.css), not at the default size of the browser.
    for (const key of ["fixture.family", "fixture.home"]) {
      assert.ok(document.querySelector(`[data-set="${key}"]`).classList.contains("text-field"), `${key} does not fill its row`);
    }
    for (const side of ["left", "right", "top", "bottom"]) assert.equal(controlOf(`link:window-${side}:fixture`).tag, "SELECT", `no window ${side} selector`);
    assert.ok(!document.body.textContent.includes("포커스와 무관하게"), "the plugin page states that the window sets ignore the focus");

    ui.showSection("sidebars");
    ui.editSet("set-1");
    const layout = ui.settingsModalState().controls.find((item) => item.key === "layout:set-1");
    assert.deepEqual([layout?.name, layout?.value, layout?.options, layout?.command],
      ["core.settings-modal.set", "list", ["list", "tabs"], { name: "core.settings.sets.update", params: { id: "set-1", scope: "common" } }]);
    assert.equal(document.querySelector('[data-set="layout:set-1"]').dataset.value, "layout");
    assert.ok(document.querySelector('[data-set="title:set-1"]').classList.contains("text-field"), "the set name does not fill its row");
  } finally {
    ui.closeSettings();
    dom.window.close();
  }
});

// The modal status reports the pane that scrolls beside the card: the head of the card covers the content that the scroll clips, so
// a control is reachable only inside the pane (docs/spec/settings.md).
test("the settings modal reports the pane that scrolls beside the card", async (t) => {
  const dom = new JSDOM("<body><div id=plane></div></body>", { url: "http://localhost/" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.CSS = dom.window.CSS ?? { escape: (text) => text };
  globalThis.addEventListener = dom.window.addEventListener.bind(dom.window);
  t.mock.module("../compositor.js", { exports: {
    ...await import("../compositor.js"), standIn: () => {},
  } });
  t.mock.module("../environment.js", { exports: { pluginUnits: () => [] } });
  const ui = await import("../settings-ui.js?pane");
  try {
    ui.openSettings();
    ui.showSection("general");
    const card = document.getElementById("settings");
    const pane = card.querySelector(".set-card__pane");
    const boxes = new Map([[card, { left: 320, top: 72, width: 560, height: 540 }], [pane, { left: 468, top: 118, width: 404, height: 486 }]]);
    for (const [el, box] of boxes) el.getBoundingClientRect = () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top });
    const { card: reportedCard, pane: reportedPane } = ui.settingsModalState();
    assert.deepEqual(reportedCard, { x: 320, y: 72, w: 560, h: 540 }, "the card is not the rectangle of the settings card");
    assert.deepEqual(reportedPane, { x: 468, y: 118, w: 404, h: 486 }, "the pane is not the rectangle of the scrolling box");
    assert.ok(reportedPane.y > reportedCard.y && reportedPane.y + reportedPane.h < reportedCard.y + reportedCard.h,
      "the pane does not lie under the head inside the card");
  } finally {
    ui.closeSettings();
    dom.window.close();
  }
});
