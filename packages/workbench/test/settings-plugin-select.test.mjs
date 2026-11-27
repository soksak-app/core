// The plugin page of a plugin with a setting of the type plugin draws a select box of the loaded and enabled plugins of its category, by
// name, with the stored value selected (docs/spec/settings.md#controls).
import assert from "node:assert/strict";
import test from "node:test";
import { startSettingsTab, openSettingsTab } from "./support/settings-tab-window.mjs";

const SURFACE = { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } };
const ctx = await startSettingsTab(null, {
  setup: async () => {
    const { installEnvironment } = await import("../environment.js");
    const refused = installEnvironment({
      runtime: "runtime",
      workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: "cli", title: "씨엘아이" }] } } },
      sidebars: { sets: [], links: [] },
    }, { plugins: [
      { id: "cli", package: "@fixture/cli", version: "1.0.0", folder: "/installed/plugin", manifest: {
        id: "cli", name: "씨엘아이", description: "명령 도구.", mark: "c", icon: "<path/>", surface: SURFACE, requires: ["terminal"],
        settings: { shell: { type: "plugin", category: "terminal", label: "셸", description: "셸로 쓸 터미널 플러그인." } },
      } },
      { id: "term", package: "@fixture/term", version: "1.0.0", folder: "/installed/plugin", manifest: {
        id: "term", name: "터미널", description: "터미널 표면.", mark: "t", icon: "<path/>", surface: SURFACE, categories: ["terminal"],
      } },
    ] });
    if (refused.length > 0) throw new Error(`fixture refused: ${refused.join(", ")}`);
  },
});

test("the plugin page shows a select of the plugins of its category by name, with the one plugin selected", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.plugin", { plugin: "cli" });
  const select = document.querySelector('select[data-set="cli.shell"]');
  assert.ok(select, "the plugin setting is not drawn as a select box");
  assert.deepEqual([...select.options].map((option) => [option.value, option.textContent]), [["term", "터미널"]],
    "the select does not list the plugins of the category by name");
  assert.equal(select.value, "term", "the one plugin of the category is not selected");
});
