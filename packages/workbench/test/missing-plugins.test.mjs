// The missing plugins of a set (docs/spec/plugins.md#missing-plugins): a section whose plugin is not loaded is kept in the set, its chip
// is dashed and struck through, a set line and a sidebar show one warning line per plugin with the button of its state, and a tab of a
// tab layout keeps its place in the set order, dimmed and struck through, and never shows the word Not loaded.
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<body><div id="plane"></div></body>', { url: "https://example.test/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.ErrorEvent = dom.window.ErrorEvent;
globalThis.dispatchEvent = (event) => dom.window.dispatchEvent(event);

const { registry } = await import("../exposure.js");
const { readFileSync } = await import("node:fs");
registry.declare("core", JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes);
const { registerPlugin, registerSection } = await import("../registry.js");
const { missingGroups, missingText, missingLineNode } = await import("../missing-plugins.js");
const { drawSet } = await import("../sidebar-sections.js");

registerPlugin({ id: "probe", name: "Probe", mark: "p", svg: "<path/>", ink: null, background: null, drop: null, surface: () => null });
const composition = { kind: "view", page: "ui/tree.html" };
registerSection({ actions: [], id: "probe.tree", name: "Tree", composition, height: "fill", plugin: "probe",
  surface: (surfaceId, start) => ({ composition, surfaceId, pluginId: "probe", declarations: {}, sidecars: [], diagnostics: null,
    unload: false, params: null, section: start }) });

const row = (over) => ({ id: "gone", name: "Gone", description: "", state: "available", installed: null, latest: "1.2.0",
  incompatible: false, composition: null, sidecars: [], ...over });

test("missingGroups lists each plugin of a section that is not loaded once, in set order, with its section count", () => {
  const groups = missingGroups(["probe.tree", "gone.a", "other.x", "gone.b"], [row({})]);
  assert.deepEqual(groups.map((g) => [g.id, g.name, g.sections]), [["gone", "Gone", ["gone.a", "gone.b"]], ["other", "other", ["other.x"]]]);
});

test("missingText gives the title, the text and the button of each state, and no warning for a reloading plugin", () => {
  const group = (state, latest = "1.2.0") => ({ id: "gone", name: "Gone", sections: ["gone.a", "gone.b"], state, latest });
  assert.deepEqual(missingText(group("available")), {
    title: "Gone(gone)", text: "플러그인이 없어 섹션 2개를 못 보여 준다.",
    button: { label: "Gone 설치", command: "core.plugins.install", params: { plugin: "gone" } } });
  assert.deepEqual(missingText(group("absent", null)), { title: "Gone(gone)", text: "플러그인이 없어 섹션 2개를 못 보여 준다.", button: null });
  assert.deepEqual(missingText(group("available", null)).button, null, "the install button is absent when the catalog does not list the plugin");
  assert.deepEqual(missingText(group("disabled")), {
    title: "Gone(gone)", text: "플러그인이 꺼져 있어 섹션 2개를 못 보여 준다.",
    button: { label: "켜기", command: "core.plugins.enable", params: { plugin: "gone" } } });
  for (const state of ["refused", "requires"]) assert.deepEqual(missingText(group(state)), {
    title: "Gone(gone)", text: "플러그인을 불러오지 못해 섹션 2개를 못 보여 준다.",
    button: { label: "설치됨 보기", command: "core.plugins.browse", params: {} } });
  assert.equal(missingText(group("reload")), null);
});

function sidebar() {
  const container = document.createElement("div");
  container.className = "set";
  document.getElementById("plane").append(container);
  return container;
}
const context = { space: "spc-mmmmmm", orientation: "horizontal", window: true, statusText: "왼쪽 창 사이드바" };

test("a tab layout keeps the missing section in its set order as a dimmed, struck tab with no surface", () => {
  const container = sidebar();
  drawSet(container, "left", { id: "mixed", title: "Mixed", layout: "tabs", sections: ["gone.a", "probe.tree"] }, context);
  const tabs = [...container.querySelectorAll(".set__tabs > *")];
  assert.deepEqual(tabs.map((t) => [t.textContent, t.classList.contains("set__tab--missing")]), [["gone.a", true], ["Tree", false]]);
  assert.equal(container.querySelectorAll('[data-section="gone.a"]').length, 0, "no section element is drawn for the missing section");
});

test("the status line of a window sidebar without a warning shows its side and its plugin", () => {
  const container = sidebar();
  const footer = document.createElement("footer");
  drawSet(container, "left", { id: "ok", title: "Ok", layout: "list", sections: ["probe.tree"] }, { ...context, side: "left", plugin: "probe", statusText: "왼쪽 창 사이드바 · probe" }, footer);
  assert.equal(footer.querySelector('[data-expose="core.sidebar.missing"]'), null);
  assert.equal(footer.textContent, "왼쪽 창 사이드바 · probe");
});

test("missingLineNode draws the line element with the plugin, the warning tone and its button", () => {
  const node = missingLineNode(document, { id: "gone", name: "Gone", sections: ["gone.a"], state: "disabled", latest: "1.2.0" });
  assert.equal(node.dataset.expose, "core.sidebar.missing");
  assert.equal(node.dataset.plugin, "gone");
  assert.ok(node.classList.contains("missing-line--warn"));
  const button = node.querySelector("button");
  assert.equal(button.textContent, "켜기");
  assert.equal(button.dataset.expose, "core.sidebar.missing");
});

test("a chip of a missing section is dashed, struck through and titled with the plugin, and no node shows the word 불러오지 않음", async () => {
  const { missingChipNode } = await import("../missing-plugins.js");
  const chip = missingChipNode(document, "gone.a", { id: "gone", name: "Gone", sections: ["gone.a"], state: "available", latest: "1.2.0" });
  assert.equal(chip.className, "set-chip set-chip--missing");
  assert.equal(chip.textContent, "gone.a");
  assert.equal(chip.title, "Gone(gone) 플러그인 필요");
  assert.equal(chip.dataset.section, "gone.a");
  assert.equal(document.body.textContent.includes("불러오지 않음"), false);
});
