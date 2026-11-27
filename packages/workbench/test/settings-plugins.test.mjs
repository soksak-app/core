// The installed plugins of the settings tab list the loaded plugins by name, and the plugin page leaves the installation and the
// versions to the plugin screen (docs/spec/settings.md#plugins).
import assert from "node:assert/strict";
import test from "node:test";
import { startSettingsTab, openSettingsTab } from "./support/settings-tab-window.mjs";

const SURFACE = { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } };
const ctx = await startSettingsTab(null, {
  setup: async () => {
    const { installEnvironment } = await import("../environment.js");
    const refused = installEnvironment({
      runtime: "runtime",
      workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: "alpha", title: "알파" }] } } },
      sidebars: { sets: [], links: [] },
    }, { plugins: [
      { id: "alpha", package: "@fixture/alpha", version: "1.0.0", folder: "/installed/plugin", manifest: {
        id: "alpha", name: "알파", description: "알파 표면.", mark: "a", icon: "<path/>", surface: SURFACE, categories: ["terminal"],
        // A contribution to an extension point that no installed plugin provides, so its state is provider-missing.
        contributes: { "fixture.language": [{ range: "^1.0.0", module: "ui/language.js", name: "alpha" }] },
      } },
      // A plugin declares a surface, sections or contributions, so the plugin without a surface declares one section.
      { id: "beta", package: "@fixture/beta", version: "1.0.0", folder: "/installed/plugin", manifest: {
        id: "beta", name: "베타", description: "베타 목록.",
        // A point that alpha does not declare in its extends, so the contribution of beta is invalid.
        contributes: { "alpha.nothing": [{ range: "^1.0.0", module: "ui/nothing.js", name: "beta" }] },
        sections: [{ id: "beta.list", name: "목록", height: "fill", composition: { kind: "view", page: "ui/list.html" } }],
      } },
    ] });
    if (refused.length > 0) throw new Error(`fixture refused: ${refused.join(", ")}`);
  },
});

test("the installed page lists the loaded plugins by name", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.nav", { page: "installed" });
  // The rows are in the order of their names, beta before alpha by the code points of the Korean text.
  const rows = [...document.querySelectorAll('[data-expose="core.settings-tab.plugin-row"]')];
  assert.deepEqual(rows.map((row) => row.dataset.plugin), ["beta", "alpha"]);
  assert.deepEqual((await ctx.status("core.settings-tab")).listed, ["beta", "alpha"], "the status lists the rows in their order");
});

test("the meta line of a row reads its plugin category and its key, and leaves out a category that the plugin does not have", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.nav", { page: "installed" });
  assert.equal(document.querySelector('[data-plugin="alpha"] .set-caption')?.textContent, "terminal · alpha");
  assert.equal(document.querySelector('[data-plugin="beta"] .set-caption')?.textContent, "beta");
});

test("a plugin that is not listed is refused, and the plugin page shows no plugin versions", async () => {
  await assert.rejects(ctx.run("core.settings-tab.plugin", { plugin: "db" }), /plugin db is not listed/);
  await ctx.run("core.settings-tab.plugin", { plugin: "alpha" });
  assert.equal(document.querySelector("[data-plugin-versions]"), null, "the plugin page shows the plugin versions");
});

test("the plugin page draws each contribution of the plugin as a named line with its state", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.plugin", { plugin: "alpha" });
  assert.deepEqual([...document.querySelectorAll('[data-expose="core.settings-tab.plugins.contribution"]')].map((el) => el.textContent),
    ["fixture.language 기여 1: 제공자 없음"]);
});

test("the plugin page draws the description of the plugin as a named line", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.plugin", { plugin: "alpha" });
  assert.equal(document.querySelector('[data-expose="core.settings-tab.plugins.about"]')?.textContent, "알파 표면.");
});

test("an invalid contribution shows its point, its number and its reason as its line and through the error display", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.plugin", { plugin: "beta" });
  assert.deepEqual([...document.querySelectorAll('[data-expose="core.settings-tab.plugins.contribution"]')].map((el) => el.textContent),
    ["alpha.nothing 기여 1: alpha 1.0.0 declares no extension point nothing"]);
  const errors = (await ctx.status("core.settings-tab")).errors;
  assert.ok(errors.some((line) => line.key === "plugin beta contribution alpha.nothing 1"
    && line.text === "alpha.nothing 기여 1: alpha 1.0.0 declares no extension point nothing"),
  "the invalid contribution does not show its error through the error display");
});
