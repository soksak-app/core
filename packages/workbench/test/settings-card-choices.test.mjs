// The card sidebar links of a plugin page show a missing set as off, without an inherit option, and refuse an unknown set through
// core.settings.link (docs/spec/settings.md#sidebar-choices).
import assert from "node:assert/strict";
import test from "node:test";
import { startSettingsTab, openSettingsTab } from "./support/settings-tab-window.mjs";

const SURFACE = { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } };
const ctx = await startSettingsTab(null, {
  setup: async () => {
    const { installEnvironment } = await import("../environment.js");
    const refused = installEnvironment({
      runtime: "runtime",
      workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: "fixture", title: "Fixture" }] } } },
      sidebars: { sets: [], links: [] },
    }, { plugins: [{ id: "fixture", package: "@fixture/fixture", version: "1.0.0", folder: "/installed/plugin", manifest: {
      id: "fixture", name: "Fixture", description: "Fixture card.", mark: "f", icon: "<path/>", surface: SURFACE,
    } }] });
    if (refused.length > 0) throw new Error(`fixture refused: ${refused.join(", ")}`);
  },
});

test("a card side without a set shows off, with no inherit option", async () => {
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.plugin", { plugin: "fixture" });
  for (const side of ["left", "right", "top", "bottom"]) {
    const select = document.querySelector(`[data-set="link:card-${side}:fixture"]`);
    assert.ok(select, `card-${side} control is missing`);
    assert.equal(select.value, "off", `card-${side} displayed an unavailable inherited choice`);
    assert.equal(select.selectedOptions[0].textContent, "사용 안 함");
    assert.equal([...select.options].some((option) => option.value === "inherit"), false);
  }
});

test("core.settings.link refuses a set that the sets lack, and takes off as 사용 안 함", async () => {
  await assert.rejects(ctx.run("core.settings.link", { place: "card-right", plugin: "fixture", set: "missing-set" }), /unknown set missing-set/);
  // off is the option Not in use of every side link (docs/spec/settings.md#sidebar-choices), so it is a valid choice.
  await ctx.run("core.settings.link", { place: "card-right", plugin: "fixture", set: "off" });
  assert.equal(document.querySelector('[data-set="link:card-right:fixture"]').value, "off");
  await assert.rejects(ctx.run("core.settings.link", { place: "card-right", plugin: "fixture", set: null }), /invalid params/,
    "a null set is refused: the declared set is a string");
});
