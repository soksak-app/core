// The controls of the settings tab draw each setting form with its one control (docs/spec/settings.md#controls). The status controls
// lists every control with its element name, key, command, value and options, which the tests read.
import assert from "node:assert/strict";
import test from "node:test";
import { startSettingsTab, openSettingsTab } from "./support/settings-tab-window.mjs";

const FIXTURE = {
  id: "fixture", name: "Fixture", description: "Fixture card.", mark: "f", icon: "<path/>",
  surface: { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } },
  settings: {
    shape: { label: "모양", type: "enum", values: ["block", "underline", "beam"], default: "block" },
    columns: { label: "열", type: "integer", minimum: 20, maximum: 400, default: 80 },
    family: { label: "글꼴", type: "string", maxLength: 40, default: "Menlo" },
    home: { label: "홈 주소", type: "address", default: "" },
  },
};

const ctx = await startSettingsTab(null, {
  setup: async (settings) => {
    const { installEnvironment } = await import("../environment.js");
    const surface = FIXTURE.surface;
    const result = installEnvironment({
      runtime: "runtime",
      workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: "fixture", title: "Fixture" }] } } },
      sidebars: { sets: [{ id: "set-1", title: "탐색기", sections: [], layout: "list" }], links: [] },
    }, { plugins: [{ id: "fixture", package: "@fixture/fixture", version: "1.0.0", folder: "/installed/plugin", manifest: { ...FIXTURE, surface } }] });
    if (result.length > 0) throw new Error(`fixture refused: ${result.join(", ")}`);
  },
});

/** The controls of the status with the element name and the key. */
const controls = async () => (await ctx.status("core.settings-tab")).controls;
const controlOf = async (key) => {
  const found = (await controls()).find((item) => item.key === key);
  assert.ok(found, `no control for ${key}`);
  return found;
};

test("every setting form of the common scope is drawn with its one control", async () => {
  const settings = ctx.settings;
  await openSettingsTab(ctx);
  await ctx.run("core.settings-tab.nav", { page: "look" });
  // A choice of two or three values is a segment, and a choice of four or more values is a select box (docs/spec/settings.md#controls).
  for (const key of ["mode", "focusInd", "fullRule"]) {
    const control = await controlOf(key);
    assert.equal(control.name, "core.settings-tab.choice", `${key} is not drawn by the choice control`);
    assert.equal(control.options, null, `${key} is a select box`);
  }
  const font = await controlOf("font");
  assert.equal(font.name, "core.settings-tab.choice");
  assert.equal(font.options.length, settings.FONTS.length, "the font choice has one option per font");
  const modes = (await controls()).filter((item) => item.key === "mode");
  assert.deepEqual(modes.map((item) => [item.label, item.on]), [["어두움", true], ["밝음", false]], "the segment shows the applied value");
  assert.deepEqual(settings.CHOICES.fullRule, ["under", "over", "none"]);
  // The card auto-arrange setting has the two declared choices, resize and even, drawn as a segment with one button per choice.
  await ctx.run("core.settings-tab.nav", { page: "behavior" });
  const arrange = (await controls()).filter((item) => item.key === "cardArrange");
  assert.deepEqual(arrange.map((item) => item.name), ["core.settings-tab.choice", "core.settings-tab.choice"]);
  assert.deepEqual(settings.CHOICES.cardArrange, ["resize", "even"]);
});

test("the switches of the workspace are checkboxes of the side control", async () => {
  await ctx.run("core.settings-tab.nav", { page: "workspace" });
  for (const key of ["left", "right", "top", "bottom"]) {
    const found = await controlOf(key);
    assert.equal(found.name, "core.settings-tab.side", `${key} is not drawn by the side control`);
    assert.equal(typeof found.on, "boolean", `${key} is not a switch`);
    assert.equal(document.querySelector(`[data-set="${key}"]`).type, "checkbox");
  }
});

test("the sidebar order is one row per side with ↑ and ↓ that write the whole order", async () => {
  await ctx.run("core.settings-tab.nav", { page: "workspace" });
  const rows = [...document.querySelectorAll(".set-side")];
  assert.equal(rows.length, 4, "the sidebar group has four rows");
  const up = rows[1].querySelector('[title="위로"]');
  assert.equal(up.dataset.command, "core.settings.change");
  assert.deepEqual(JSON.parse(up.dataset.params), { key: "sidebarOrder", value: ["right", "left", "top", "bottom"], scope: "common" });
  assert.equal(rows[0].querySelector('[title="위로"]').disabled, true, "the first row has no ↑");
  assert.equal(rows[3].querySelector('[title="아래로"]').disabled, true, "the last row has no ↓");
  assert.deepEqual([...document.querySelectorAll(".set-side__name")].map((el) => el.textContent), ["왼쪽", "오른쪽", "위", "아래"]);
});

test("the sidebar group shows the shortcuts under the list in a fixed order", async () => {
  await ctx.run("core.settings-tab.nav", { page: "workspace" });
  const shortcuts = "⌘B 왼쪽 · ⌥⌘B 오른쪽 · ⇧⌘J 위 · ⌘J 아래";
  const line = [...document.querySelectorAll("p, span, div")].find((el) => el.children.length === 0 && el.textContent === shortcuts);
  assert.ok(line, "the sidebar group has no shortcut line under the list");
  assert.ok(document.querySelector(".set-sides").compareDocumentPosition(line) & window.Node.DOCUMENT_POSITION_FOLLOWING, "the shortcut line does not follow the list");
});

test("the sizes are sliders or steppers and the memory delay is bounded in minutes", async () => {
  await ctx.run("core.settings-tab.nav", { page: "look" });
  await ctx.run("core.settings-tab.nav", { page: "behavior" });
  const delay = document.querySelector('[data-set="memorySaverDelay"]');
  assert.ok(delay, "the memory delay has no control");
  assert.deepEqual([delay.type, delay.min, delay.max], ["range", "5", "720"]);
  assert.equal((await controlOf("memorySaverDelay")).name, "core.settings-tab.set");
  // The stepper is one exposed box, core.settings-tab.stepper; its buttons keep core.settings-tab.step (docs/spec/settings.md#controls).
  assert.equal((await controlOf("problemToastDismissSeconds")).name, "core.settings-tab.stepper");
});

test("a plugin page shows its declared settings with their controls", async () => {
  await ctx.run("core.settings-tab.plugin", { plugin: "fixture" });
  assert.equal((await ctx.status("core.settings-tab")).plugin, "fixture");
  assert.equal((await controlOf("fixture.shape")).name, "core.settings-tab.choice");
  // Three values are a segment with one button per value, in the declared order.
  assert.deepEqual((await controls()).filter((item) => item.key === "fixture.shape").map((item) => item.label), ["block", "underline", "beam"]);
  // An integer over the range 20 to 400 is a slider, the same as the memory delay.
  assert.equal((await controlOf("fixture.columns")).name, "core.settings-tab.set");
  for (const key of ["fixture.family", "fixture.home"]) {
    assert.ok(document.querySelector(`[data-set="${key}"]`).classList.contains("text-field"), `${key} does not fill its row`);
  }
});

test("the sets page draws the set name as a text field that fills its row", async () => {
  await ctx.run("core.settings-tab.nav", { page: "sets" });
  await ctx.run("core.settings-tab.edit", { set: "set-1" });
  const title = document.querySelector('[data-expose="core.settings-tab.set-title"]');
  assert.ok(title, "the set name has no field");
  assert.ok(title.classList.contains("text-field"), "the set name does not fill its row");
  assert.equal(title.value, "탐색기");
});
