// The row component of the settings grid (docs/spec/settings.md#rows and docs/spec/settings.md#performance). Every row of a page is one
// `.set-row` element built by row() of settings-controls.js: a label cell with the name and the description, and a control column for the
// control and the scope marks. A value change draws again only the row of the changed setting and of the settings that depend on it, so
// every other row element keeps its identity.
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
  setup: async () => {
    const { installEnvironment } = await import("../environment.js");
    const result = installEnvironment({
      runtime: "runtime",
      workspace: { focus: "main", grid: { root: { card: "main", tabs: [{ plugin: "fixture", title: "Fixture" }] } } },
      sidebars: { sets: [], links: [] },
    }, { plugins: [{ id: "fixture", package: "@fixture/fixture", version: "1.0.0", folder: "/installed/plugin", manifest: FIXTURE }] });
    if (result.length > 0) throw new Error(`fixture refused: ${result.join(", ")}`);
  },
});
await openSettingsTab(ctx);

const { row } = await import("../settings-controls.js");
const { rangeOf } = await import("../settings-rows.js");

/** The row elements of the pane by their key. */
const rows = () => new Map([...document.querySelectorAll(".set-row[data-row]")].map((el) => [el.dataset.row, el]));
/** The effective value of a common setting, which the pane shows in the common scope. */
const valueOf = (key) => ctx.settings.scopedValue(key, "common");
/** The element of a row, failing when the page does not show it. */
const rowOf = (key) => {
  const el = rows().get(key);
  assert.ok(el, `the page shows no row ${key}`);
  return el;
};

/**
 * Asserts that the page keeps every row element except the changed rows: each changed key has a new element, and each other key keeps
 * the element it had before the change.
 */
function assertOnlyRowsDrawn(before, after, changed) {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), "the rows of the page differ after the change");
  for (const [key, el] of before) {
    if (changed.includes(key)) assert.notEqual(after.get(key), el, `the row ${key} was not drawn again`);
    else assert.equal(after.get(key), el, `the row ${key} was drawn again`);
  }
}

/** Opens a page, runs a value change through its command and checks that only the changed rows were drawn again. */
async function changeAndCompare(page, changed, command, params) {
  await ctx.run("core.settings-tab.nav", { page });
  const before = rows();
  await ctx.run(command, params);
  assertOnlyRowsDrawn(before, rows(), changed);
}

test("every row of a core page has a label cell with the name and a control column", async () => {
  for (const page of ["look", "workspace", "behavior", "diag"]) {
    await ctx.run("core.settings-tab.nav", { page });
    const shown = [...document.querySelectorAll(".set-row[data-row]")];
    assert.ok(shown.length > 0, `the ${page} page shows no rows`);
    for (const el of shown) {
      assert.equal(el.firstElementChild.className, "set-row__label", `${el.dataset.row} has no label cell first`);
      assert.ok(el.querySelector(".set-row__label > .set-row__name"), `${el.dataset.row} has no name`);
      // The control column is the only other child, and it exists only for a row with a control or a scope mark.
      assert.ok(el.children.length <= 2, `${el.dataset.row} has more than a label cell and a control column`);
      if (el.children.length === 2) assert.equal(el.children[1].className, "set-row__control", `${el.dataset.row} has no control column`);
    }
  }
});

test("a row without a label keeps an empty label cell and its control in the control column", () => {
  const el = row({ label: "", control: document.createElement("input"), key: "probe" });
  assert.equal(el.dataset.row, "probe");
  assert.equal(el.firstElementChild.className, "set-row__label");
  assert.equal(el.querySelector(".set-row__name").textContent, "");
  assert.equal(el.lastElementChild.className, "set-row__control");
  assert.equal(el.lastElementChild.firstElementChild.tagName, "INPUT");
});

test("each form draws its control in the control column of its row", async () => {
  await ctx.run("core.settings-tab.nav", { page: "look" });
  // A choice of two values is a segment with one button per value, pressed on the applied value.
  const focus = rowOf("focusInd").querySelector(".set-row__control > .set-seg");
  assert.equal(focus.querySelectorAll("button").length, ctx.settings.CHOICES.focusInd.length);
  // A choice of four or more values is a select box with one option per value.
  const font = rowOf("font").querySelector(".set-row__control .select-field select");
  assert.equal(font.options.length, ctx.settings.FONTS.length);
  // A switch is a checkbox in the control column.
  assert.equal(rowOf("dim").querySelector(".set-row__control > input.set-switch[type=checkbox]").type, "checkbox");
  // A slider is a range input with the bounds of its key, and an output with the unit.
  const [min, max] = rangeOf("gap");
  const gap = rowOf("gap").querySelector(".set-row__control .set-slide input[type=range]");
  assert.deepEqual([gap.min, gap.max], [String(min), String(max)]);
  assert.ok(rowOf("gap").querySelector(".set-row__control .set-slide output"), "the slider has no value output");
  // A stepper is two buttons around the value.
  const size = rowOf("size").querySelector(".set-row__control .set-step");
  assert.equal(size.querySelectorAll("button").length, 2);
  assert.ok(size.querySelector("output"), "the stepper has no value output");
  // The theme row takes the whole row, with the swatch grid in it.
  assert.ok(rowOf("theme").classList.contains("set-row--wide"));
  assert.ok(rowOf("theme").querySelector(".th-grid .th"), "the theme row has no swatch");
});

test("a row that depends on another is indented under it", async () => {
  await ctx.run("core.settings-tab.nav", { page: "behavior" });
  assert.ok(rowOf("memorySaverDelay").classList.contains("set-row--indent"));
  assert.ok(rowOf("problemToastDismissSeconds").classList.contains("set-row--indent"));
  assert.equal(rowOf("memorySaver").classList.contains("set-row--indent"), false);
});

test("a change of a segment redraws its row only", async () => {
  const next = ctx.settings.CHOICES.focusInd.find((value) => value !== valueOf("focusInd"));
  await changeAndCompare("look", ["focusInd"], "core.settings.change", { key: "focusInd", value: next, scope: "common" });
  const pressed = [...rowOf("focusInd").querySelectorAll("button")].findIndex((button) => button.getAttribute("aria-pressed") === "true");
  assert.equal(pressed, ctx.settings.CHOICES.focusInd.indexOf(next), "the segment does not press the applied value");
  assert.equal(valueOf("focusInd"), next);
});

test("a change of a select box redraws its row only", async () => {
  const next = ctx.settings.FONTS.find((font) => font.id !== valueOf("font")).id;
  await changeAndCompare("look", ["font"], "core.settings.change", { key: "font", value: next, scope: "common" });
  assert.equal(rowOf("font").querySelector("select").value, next);
});

test("a change of a switch redraws its row only", async () => {
  await changeAndCompare("look", ["dim"], "core.settings.change", { key: "dim", value: !valueOf("dim"), scope: "common" });
});

test("a change of a slider redraws its row only", async () => {
  const [min, max] = rangeOf("gap");
  const current = valueOf("gap");
  const next = current < max ? current + 1 : min;
  await changeAndCompare("look", ["gap"], "core.settings.change", { key: "gap", value: next, scope: "common" });
  assert.equal(parseFloat(rowOf("gap").querySelector(".set-slide output").textContent), next, "the slider output does not show the applied value");
});

test("a change of a stepper redraws its row only", async () => {
  const [min, max] = rangeOf("size");
  const current = valueOf("size");
  const next = current < max ? current + 1 : min;
  await changeAndCompare("look", ["size"], "core.settings.change", { key: "size", value: next, scope: "common" });
});

test("a change of a parent switch redraws the row of its dependent setting, which shows its disabled state", async () => {
  await ctx.run("core.settings-tab.nav", { page: "behavior" });
  const before = rows();
  await ctx.run("core.settings.change", { key: "memorySaver", value: !valueOf("memorySaver"), scope: "common" });
  const after = rows();
  assertOnlyRowsDrawn(before, after, ["memorySaver", "memorySaverDelay"]);
  const delayInput = after.get("memorySaverDelay").querySelector("input[type=range]");
  assert.equal(delayInput.disabled, !valueOf("memorySaver"), "the dependent slider does not show the disabled state of its parent");
});

test("a change of the debug switch's diagnostics settings redraws the debug row", async () => {
  await ctx.run("core.settings-tab.nav", { page: "diag" });
  const before = rows();
  const debug = before.get("debug").querySelector("input.set-switch");
  const on = debug.checked;
  await ctx.run("core.settings.debug", { on: !on });
  const shown = rows().get("debug").querySelector("input.set-switch");
  assert.equal(shown.checked, !on, "the debug switch does not show the diagnostics settings it reads");
});

test("a change of a plugin segment redraws its row only", async () => {
  await ctx.run("core.settings-tab.plugin", { plugin: "fixture" });
  const before = rows();
  const current = ctx.settings.scopedValue("fixture.shape", "common") ?? "block";
  const next = ["block", "underline", "beam"].find((value) => value !== current);
  await ctx.run("core.settings.change", { key: "fixture.shape", value: next, scope: "common" });
  assertOnlyRowsDrawn(before, rows(), ["fixture.shape"]);
});

test("a change of a plugin text field redraws its row only", async () => {
  await ctx.run("core.settings-tab.plugin", { plugin: "fixture" });
  const before = rows();
  await ctx.run("core.settings.change", { key: "fixture.family", value: "Courier", scope: "common" });
  assertOnlyRowsDrawn(before, rows(), ["fixture.family"]);
  assert.equal(rowOf("fixture.family").querySelector("input.text-field").value, "Courier");
});
