// The warning of a missing plugin of a sidebar is a notice of the notice path, with the sidebar as its source (docs/spec/plugins.md#missing-plugins,
// docs/spec/notifications.md#sidebar-notices): it shows on the status line of the sidebar, becomes a toast by the focus rule, merges by
// origin, and is withdrawn when the sidebar stops drawing the sections of the plugin. The notice center keeps its entry.
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
const { drawSet, sidebarsState } = await import("../sidebar-sections.js");
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

test("a window sidebar's missing plugin is a warning notice on its status line, and no line sits above its sections", () => {
  const container = sidebar();
  const footer = document.createElement("footer");
  drawSet(container, "win-status", { id: "list", title: "List", layout: "list", sections: ["gone.a", "gone.b", "probe.tree"] }, windowContext, footer);
  assert.equal(container.querySelectorAll('[data-expose="core.sidebar.missing"]').length, 0, "no warning line above the sections");
  const line = footer.querySelector(".notice-line");
  assert.notEqual(line, null, "the status line of the sidebar shows the notice");
  assert.equal(line.dataset.kind, "warning");
  assert.equal(line.querySelector(".notice-line__title").textContent, "gone(gone)");
  assert.equal(line.querySelector(".notice-line__text").textContent, "플러그인이 없어 섹션 2개를 못 보여 준다.");
  assert.notEqual(line.querySelector(".notice-line__close"), null, "the notice closes with its × control");
  const [state] = sidebarsState().filter((entry) => entry.sidebar === "win-status");
  assert.equal(state.status, null, "a shown notice replaces the status text");
  assert.deepEqual([state.notice.kind, state.notice.title], ["warning", "gone(gone)"]);
});

test("a window sidebar's missing plugin is a toast and an entry of the center whose source is the sidebar", () => {
  const container = sidebar();
  const footer = document.createElement("footer");
  drawSet(container, "win-toast", { id: "list", title: "List", layout: "list", sections: ["toasted.a", "probe.tree"] }, windowContext, footer);
  assert.ok(titles().includes("toasted(toasted)"), "a window sidebar has no focus, so its warning is a toast");
  const entry = notificationStore().entries().find((e) => e.title === "toasted(toasted)");
  assert.deepEqual(entry.source, { kind: "sidebar", sidebar: "win-toast", card: null, plugin: "toasted" });
  assert.equal(entry.kind, "warning");
});

test("a card sidebar's missing plugin is a toast with the Go to card action (core.card.focus) while its card does not have the focus", () => {
  notificationStore().focusCard("card-other");
  const container = sidebar();
  const footer = document.createElement("footer");
  drawSet(container, "card-b:right", { id: "list", title: "List", layout: "list", sections: ["carded.a", "probe.tree"] }, cardContext("card-b"), footer);
  assert.ok(titles().includes("carded(carded)"));
  const toast = notificationStore().toasts().find((t) => t.title === "carded(carded)");
  assert.deepEqual(notificationStore().toastActions(toast.id).map((a) => [a.label, a.command, a.params]),
    [["카드로 가기", "core.card.focus", { card: "card-b" }]]);
});

test("a card sidebar's missing plugin is no toast while its card has the focus, and its status line still shows it", () => {
  notificationStore().focusCard("card-c");
  const container = sidebar();
  const footer = document.createElement("footer");
  drawSet(container, "card-c:left", { id: "list", title: "List", layout: "list", sections: ["focused.a", "probe.tree"] }, cardContext("card-c"), footer);
  assert.equal(titles().includes("focused(focused)"), false, "a focused card shows no toast for the sidebar notice");
  assert.equal(footer.querySelector(".notice-line__title").textContent, "focused(focused)");
});

test("a redraw of the same missing plugin keeps one notice, and a set that stops drawing its sections withdraws it from the status line and the toasts", () => {
  const container = sidebar();
  const footer = document.createElement("footer");
  const set = { id: "list", title: "List", layout: "list", sections: ["merged.a", "probe.tree"] };
  drawSet(container, "win-merge", set, windowContext, footer);
  drawSet(container, "win-merge", set, windowContext, footer);
  const entries = notificationStore().entries().filter((e) => e.title === "merged(merged)");
  assert.equal(entries.length, 1, "the same plugin in the same sidebar merges into one notice");
  assert.equal(entries[0].count, 1);
  drawSet(container, "win-merge", { id: "list", title: "List", layout: "list", sections: ["probe.tree"] }, windowContext, footer);
  assert.equal(footer.querySelector(".notice-line"), null, "the notice leaves the status line once the sections are not drawn");
  assert.equal(titles().includes("merged(merged)"), false, "the toast is withdrawn");
  assert.equal(notificationStore().entries().filter((e) => e.title === "merged(merged)").length, 1, "the notice center keeps its entry");
});

test("two missing plugins of one sidebar keep one notice each, and the status line shows the newest of them", () => {
  const container = sidebar();
  const footer = document.createElement("footer");
  drawSet(container, "win-two", { id: "two", title: "Two", layout: "list", sections: ["older.a", "newer.x", "probe.tree"] }, windowContext, footer);
  assert.ok(titles().includes("older(older)"), "the first plugin keeps its own notice");
  assert.equal(footer.querySelector(".notice-line__title").textContent, "newer(newer)", "the newest notice of the sidebar shows on its status line");
});
