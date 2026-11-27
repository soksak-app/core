// A control of the settings tab shows the applied value and the scope that the value comes from, and writes to that scope. The common
// scope shows a project value with its chip, and the project scope removes it with the reset control (docs/spec/settings.md#scope-of-a-control).
import assert from "node:assert/strict";
import test from "node:test";
import { startSettingsTab, openSettingsTab } from "./support/settings-tab-window.mjs";

const ctx = await startSettingsTab(null, {
  project: "prj-a",
  setup: async (settings) => {
    const { installEnvironment } = await import("../environment.js");
    const surface = { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } };
    const refused = installEnvironment({
      runtime: "runtime",
      workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: "alpha", title: "알파" }] } } },
      sidebars: { sets: [], links: [] },
    }, { plugins: [{ id: "alpha", package: "@fixture/alpha", version: "1.0.0", folder: "/installed/plugin", manifest: { id: "alpha", name: "알파", description: "알파 표면.", mark: "a", icon: "<path/>", surface } }] });
    if (refused.length > 0) throw new Error(`fixture refused: ${refused.join(", ")}`);
    const snapshot = {
      common: { top: false, mode: "dark", sets: [{ id: "set-1", title: "탐색기", sections: [], layout: "list" }] },
      projects: [{ id: "prj-a", root: "/work/a", title: "a", spaces: [], settings: { top: true, mode: "light", links: [{ place: "left", plugin: null, set: "set-1" }] } }],
    };
    return snapshot;
  },
});

test("the sources of a setting are the project scope for a project value and the common scope otherwise", () => {
  assert.equal(ctx.settings.sourceScope("top"), "project");
  assert.equal(ctx.settings.sourceScope("left"), "common");
});

test("the common scope shows the common value with the project chip, and writes the common scope", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.nav", { page: "workspace" });
  const top = document.querySelector('[data-expose="core.settings-tab.side"][data-set="top"]');
  assert.equal(top.checked, false, "the switch shows the common value");
  // A switch writes the value it is changed to, so its params carry the key and the scope only.
  assert.deepEqual(JSON.parse(top.dataset.params), { key: "top", scope: "common" });
  const chip = document.querySelector('[data-expose="core.settings-tab.applied"][data-key="applied:top"]');
  assert.ok(chip, "the project value has no chip");
  assert.match(chip.textContent, /: 켬$/, "the chip does not show the project value");
  assert.equal(chip.dataset.command, "core.settings-tab.scope");
  assert.deepEqual(JSON.parse(chip.dataset.params), { scope: "project" });
  await ctx.run("core.settings-tab.nav", { page: "look" });
  const modes = [...document.querySelectorAll('[data-expose="core.settings-tab.choice"][data-key="mode"]')];
  assert.equal(modes.find((el) => el.dataset.on === "true")?.textContent, "어두움", "the segment shows the common value");
  assert.deepEqual(JSON.parse(modes[0].dataset.params).scope, "common");
});

test("a setting without a project value shows and writes the common scope, and the common scope has no reset control", async () => {
  await ctx.run("core.settings-tab.nav", { page: "workspace" });
  const left = document.querySelector('[data-expose="core.settings-tab.side"][data-set="left"]');
  assert.deepEqual(JSON.parse(left.dataset.params).scope, "common");
  assert.equal(document.querySelectorAll('[data-expose="core.settings-tab.reset"]').length, 0, "the common scope shows a reset control");
});

test("the project scope marks an override with its badge and a reset control, and the reset removes the project value", async () => {
  await ctx.run("core.settings-tab.nav", { page: "look" });
  await ctx.run("core.settings-tab.scope", { scope: "project" });
  const reset = document.querySelector('[data-expose="core.settings-tab.reset"][data-key="mode"]');
  assert.ok(reset, "the overridden mode has no reset control");
  assert.deepEqual([reset.dataset.command, JSON.parse(reset.dataset.params)], ["core.settings.reset", { key: "mode", scope: "project" }]);
  // The badge names the project: "<project> 값", here the title "a" of the project.
  assert.ok([...document.querySelectorAll('[data-expose="core.settings-tab.override"]')].some((el) => el.textContent === "a 값"),
    "the overridden mode has no badge of its project");
  // The declared parameters of core.settings.reset name the key only, and the reset writes the project scope (settings.js reset).
  await ctx.run("core.settings.reset", { key: "mode" });
  assert.equal(ctx.settings.sourceScope("mode"), "common", "the reset kept the project value");
});

test("the project scope badges each row whose switch or link the project overrides, and the reset controls name each overridden key", async () => {
  await ctx.run("core.settings-tab.nav", { page: "workspace" });
  await ctx.run("core.settings-tab.scope", { scope: "project" });
  const badges = (side) => [...document.querySelector(`.set-side[data-side="${side}"]`).querySelectorAll('[data-expose="core.settings-tab.override"]')].map((el) => el.textContent);
  assert.deepEqual(badges("top"), ["a 값"], "the overridden switch has no value badge");
  assert.deepEqual(badges("left"), ["a 값"], "the overridden link has no value badge");
  assert.deepEqual(badges("right"), [], "a row without an override has a badge");
  const resets = [...document.querySelectorAll('[data-expose="core.settings-tab.reset"]')].map((el) => [el.dataset.key, JSON.parse(el.dataset.params)]);
  assert.deepEqual(resets, [["top", { key: "top", scope: "project" }], ["links", { key: "links", scope: "project" }]]);
});

test("the project scope badges every row when the project overrides the order, and the order has its reset", async () => {
  await ctx.run("core.settings-tab.nav", { page: "workspace" });
  await ctx.run("core.settings-tab.scope", { scope: "project" });
  await ctx.run("core.settings.change", { key: "sidebarOrder", value: ["top", "left", "right", "bottom"], scope: "project" });
  await ctx.run("core.settings-tab.nav", { page: "workspace" });
  const badges = [...document.querySelectorAll('[data-expose="core.settings-tab.override"]')].map((el) => el.textContent);
  assert.deepEqual(badges, ["a 값", "a 값", "a 값", "a 값"], "the order override does not badge each row with the value");
  const resets = [...document.querySelectorAll('[data-expose="core.settings-tab.reset"]')].map((el) => el.dataset.key);
  assert.deepEqual(resets, ["top", "links", "sidebarOrder"]);
});

test("the plugin page badges a window row whose link or order the project overrides, and resets the link and the order", async () => {
  await ctx.run("core.settings-tab.scope", { scope: "project" });
  await ctx.run("core.settings.link", { place: "window-left", plugin: "alpha", set: "set-1", scope: "project" });
  await ctx.run("core.settings-tab.plugin", { plugin: "alpha" });
  const windows = () => [...document.querySelectorAll(".set-group")].find((group) => group.querySelector(".set-group__name").textContent === "창 사이드바");
  const badges = (side) => [...windows().querySelector(`.set-side[data-side="${side}"]`).querySelectorAll('[data-expose="core.settings-tab.override"]')].map((el) => el.textContent);
  assert.deepEqual(badges("left"), ["a 값"], "the overridden link of the window row has no value badge");
  assert.deepEqual(badges("right"), [], "a window row without an override has a badge");
  const resets = () => [...windows().querySelectorAll('[data-expose="core.settings-tab.reset"]')].map((el) => el.dataset.key);
  assert.deepEqual(resets(), ["links"]);
  await ctx.run("core.settings.change", { key: "alpha.win.order", value: ["top", "left", "right", "bottom"], scope: "project" });
  await ctx.run("core.settings-tab.plugin", { plugin: "alpha" });
  assert.deepEqual([...windows().querySelectorAll('[data-expose="core.settings-tab.override"]')].map((el) => el.textContent), ["a 값", "a 값", "a 값", "a 값"], "the overridden order of the window rows has no value badge");
  assert.deepEqual(resets(), ["alpha.win.order", "links"]);
});
