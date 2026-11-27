// The warning of a missing plugin of a sidebar is one line at the top of the sidebar, with its action, and a record of the notice path
// (docs/spec/plugins.md#missing-plugins, docs/spec/notifications.md#sidebar-notices): the record is an entry of the notice center whose
// source is the sidebar, and it is no toast and no line of the status line. It is withdrawn when the sidebar stops drawing the sections.
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
const { drawSet } = await import("../sidebar-sections.js");
const { notificationStore } = await import("../tab-reports.js");

registerPlugin({ id: "probe", name: "Probe", mark: "p", svg: "<path/>", ink: null, background: null, drop: null, surface: () => null });
const composition = { kind: "view", page: "ui/tree.html" };
registerSection({ actions: [], id: "probe.tree", name: "Tree", composition, height: "fill", plugin: "probe",
  surface: (surfaceId, start) => ({ composition, surfaceId, pluginId: "probe", declarations: {}, sidecars: [], diagnostics: null,
    unload: false, params: null, section: start }) });

function sidebar() {
  const container = document.createElement("div");
  container.className = "set";
  document.getElementById("plane").append(container);
  return container;
}
const windowContext = { space: "spc-mmmmmm", orientation: "horizontal", window: true, statusText: "왼쪽 창 사이드바" };
const cardContext = (card) => ({ space: "spc-mmmmmm", orientation: "vertical", card, surface: null, statusText: "왼쪽 사이드바 · List" });
const titles = () => notificationStore().toasts().map((t) => t.title);
const lines = (container) => [...container.querySelectorAll(':scope > [data-expose="core.sidebar.missing"]')];

test("a window sidebar's missing plugin is one line at the top of the sidebar, before its sections, with its action", () => {
  const container = sidebar();
  const footer = document.createElement("footer");
  drawSet(container, "win-status", { id: "list", title: "List", layout: "list", sections: ["gone.a", "gone.b", "probe.tree"] }, windowContext, footer);
  const [line] = lines(container);
  assert.notEqual(line, undefined, "the warning line stands at the top of the sidebar");
  assert.equal(container.firstElementChild, line, "the warning line is the first child, above the sections");
  assert.equal(line.textContent.includes("플러그인이 없어 섹션 2개를 못 보여 준다."), true);
  assert.equal(line.dataset.plugin, "gone", "the line names its plugin");
  assert.equal(footer.querySelector(".notice-line"), null, "the status line shows no warning notice");
});

test("a window sidebar's missing plugin is an entry of the center whose source is the sidebar, and no toast", () => {
  const container = sidebar();
  const footer = document.createElement("footer");
  drawSet(container, "win-toast", { id: "list", title: "List", layout: "list", sections: ["toasted.a", "probe.tree"] }, windowContext, footer);
  assert.equal(titles().includes("toasted(toasted)"), false, "the warning is no toast");
  const entry = notificationStore().entries().find((e) => e.title === "toasted(toasted)");
  assert.deepEqual(entry.source, { kind: "sidebar", sidebar: "win-toast", card: null, plugin: "toasted" });
  assert.equal(entry.kind, "warning");
});

test("a card sidebar's missing plugin is no toast while its card does not have the focus, and its line stands at the top", () => {
  notificationStore().focusCard("card-other");
  const container = sidebar();
  const footer = document.createElement("footer");
  drawSet(container, "card-b:right", { id: "list", title: "List", layout: "list", sections: ["carded.a", "probe.tree"] }, cardContext("card-b"), footer);
  assert.equal(titles().includes("carded(carded)"), false, "the warning of a card sidebar is no toast");
  assert.equal(lines(container).length, 1, "the card sidebar shows its line at the top");
  assert.equal(footer.querySelector(".notice-line"), null);
});

test("a redraw of the same missing plugin keeps one notice, and a set that stops drawing its sections removes its line", () => {
  const container = sidebar();
  const footer = document.createElement("footer");
  const set = { id: "list", title: "List", layout: "list", sections: ["merged.a", "probe.tree"] };
  drawSet(container, "win-merge", set, windowContext, footer);
  drawSet(container, "win-merge", set, windowContext, footer);
  const entries = notificationStore().entries().filter((e) => e.title === "merged(merged)");
  assert.equal(entries.length, 1, "the same plugin in the same sidebar merges into one notice");
  assert.equal(entries[0].count, 1);
  assert.equal(lines(container).length, 1, "one line for the plugin after a redraw");
  drawSet(container, "win-merge", { id: "list", title: "List", layout: "list", sections: ["probe.tree"] }, windowContext, footer);
  assert.equal(lines(container).length, 0, "the line leaves the sidebar once the sections are not drawn");
  assert.equal(notificationStore().entries().filter((e) => e.title === "merged(merged)").length, 1, "the notice center keeps its entry");
});

test("two missing plugins of one sidebar give two lines at the top in set order, and no status notice", () => {
  const container = sidebar();
  const footer = document.createElement("footer");
  drawSet(container, "win-two", { id: "two", title: "Two", layout: "list", sections: ["older.a", "newer.x", "probe.tree"] }, windowContext, footer);
  assert.deepEqual(lines(container).map((line) => line.dataset.plugin), ["older", "newer"]);
  assert.equal(footer.querySelector(".notice-line"), null);
});
