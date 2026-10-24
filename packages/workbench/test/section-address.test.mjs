// The control address of a dom request for core.sidebar.section.control (docs/spec/declared-ui.md, control address).
import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { EXPOSURE_ERRORS } from "@soksak/plugin-api";
import { resolveSectionControl } from "../section-address.js";
import * as sectionAddress from "../section-address.js";

const { document } = new JSDOM(`
<div class="set" data-sidebar="left"><section class="set__section" data-section="side.count">
  <button data-expose="core.sidebar.section.control" data-key="go"></button>
  <button data-expose="core.sidebar.section.control" data-key="t1" data-path='["b"]' data-role="expand"></button>
  <button data-expose="core.sidebar.section.control" data-key="t1" data-path='["b"]' data-role="label"></button>
  <button data-expose="core.sidebar.section.control" data-key="t1" data-path='["b"]' data-role="action" data-action="rename"></button>
</section></div>
<div class="set" data-sidebar="right"><section class="set__section" data-section="side.count">
  <button data-expose="core.sidebar.section.control" data-key="go"></button>
</section></div>`).window;
const all = [...document.querySelectorAll('[data-expose="core.sidebar.section.control"]')];
const [leftGo, expand, label, action, rightGo] = all;

/** The code of the refusal of an address, or null when the address resolves. */
function refusal(address) {
  try {
    resolveSectionControl(address, all);
  } catch (error) {
    return error.code;
  }
  return null;
}

test("an address names one control by its sidebar, section and key, and by its path and role for a row or node", () => {
  assert.equal(resolveSectionControl({ sidebar: "left", section: "side.count", key: "go" }, all), leftGo);
  assert.equal(resolveSectionControl({ sidebar: "right", section: "side.count", key: "go" }, all), rightGo);
  assert.equal(resolveSectionControl({ sidebar: "left", section: "side.count", key: "t1", path: ["b"], role: "expand" }, all), expand);
  assert.equal(resolveSectionControl({ sidebar: "left", section: "side.count", key: "t1", path: ["b"], role: "label" }, all), label);
});

test("a unique root control resolves without path or role when tree children share its key", () => {
  const { document: treeDocument } = new JSDOM(`
    <div data-sidebar="left"><section class="set__section" data-section="side.tree">
      <button data-expose="core.sidebar.section.control" data-key="tree" id="root"></button>
      <button data-expose="core.sidebar.section.control" data-key="tree" data-path='["root"]' data-role="expand" id="expand"></button>
      <button data-expose="core.sidebar.section.control" data-key="tree" data-path='["root"]' data-role="label" id="label"></button>
    </section></div>`).window;
  const treeControls = [...treeDocument.querySelectorAll('[data-expose="core.sidebar.section.control"]')];
  const address = { sidebar: "left", section: "side.tree", key: "tree" };
  assert.equal(resolveSectionControl(address, treeControls), treeDocument.querySelector("#root"));
  assert.equal(resolveSectionControl({ ...address, path: ["root"], role: "label" }, treeControls),
    treeDocument.querySelector("#label"));
  assert.equal(resolveSectionControl({ ...address, path: ["root"], role: "expand" }, treeControls),
    treeDocument.querySelector("#expand"));
});

test("multiple no-role root controls with one key are explicitly ambiguous", () => {
  const { document: treeDocument } = new JSDOM(`
    <div data-sidebar="left"><section class="set__section" data-section="side.tree">
      <button data-expose="core.sidebar.section.control" data-key="tree" id="root-a"></button>
      <button data-expose="core.sidebar.section.control" data-key="tree" id="root-b"></button>
      <button data-expose="core.sidebar.section.control" data-key="tree" data-path='["root"]' data-role="label"></button>
    </section></div>`).window;
  const treeControls = [...treeDocument.querySelectorAll('[data-expose="core.sidebar.section.control"]')];
  assert.throws(() => resolveSectionControl({ sidebar: "left", section: "side.tree", key: "tree" }, treeControls),
    { code: EXPOSURE_ERRORS.invalidParams, message: /ambiguous root control/ });
});

test("an action address identifies one node action by path and action key", () => {
  assert.equal(resolveSectionControl({ sidebar: "left", section: "side.count", key: "t1", path: ["b"], role: "action", action: "rename" }, all), action);
  assert.equal(refusal({ sidebar: "left", section: "side.count", key: "t1", path: ["b"], role: "action", action: "missing" }), 1009);
});

test("a control of a row or a node needs both its path and its role", () => {
  assert.equal(refusal({ sidebar: "left", section: "side.count", key: "t1" }), EXPOSURE_ERRORS.invalidParams, "no path and role");
  assert.equal(refusal({ sidebar: "left", section: "side.count", key: "t1", path: ["b"] }), EXPOSURE_ERRORS.invalidParams, "no role");
  assert.equal(refusal({ sidebar: "left", section: "side.count", key: "t1", role: "expand" }), EXPOSURE_ERRORS.invalidParams, "no path");
  assert.equal(refusal({ sidebar: "left", section: "side.count", key: "t1", path: ["b"], role: "action" }), EXPOSURE_ERRORS.invalidParams, "action role without action key");
  assert.equal(refusal({ sidebar: "left", section: "side.count", key: "t1", path: ["b"], role: "label", action: "rename" }), EXPOSURE_ERRORS.invalidParams, "action key on a non-action role");
});

test("a button takes no path and no role", () => {
  assert.equal(refusal({ sidebar: "left", section: "side.count", key: "go", path: ["x"] }), EXPOSURE_ERRORS.invalidParams, "a path");
  assert.equal(refusal({ sidebar: "left", section: "side.count", key: "go", role: "label" }), EXPOSURE_ERRORS.invalidParams, "a role");
});

test("an address that matches no control is refused with 1009", () => {
  assert.equal(refusal({ sidebar: "left", section: "side.count", key: "zz" }), 1009, "an unknown key");
  assert.equal(refusal({ sidebar: "center", section: "side.count", key: "go" }), 1009, "an unknown sidebar");
  assert.equal(refusal({ sidebar: "left", section: "side.other", key: "go" }), 1009, "an unknown section");
  assert.equal(refusal({ sidebar: "left", section: "side.count", key: "t1", path: ["zz"], role: "expand" }), 1009, "an unknown path");
});

test("a value of the wrong type, an unknown field, or an address that is not an object is refused with -32602", () => {
  const base = { sidebar: "left", section: "side.count", key: "go" };
  assert.equal(refusal(null), EXPOSURE_ERRORS.invalidParams, "null");
  assert.equal(refusal({ ...base, sidebar: 1 }), EXPOSURE_ERRORS.invalidParams, "sidebar is not a string");
  assert.equal(refusal({ ...base, key: 3 }), EXPOSURE_ERRORS.invalidParams, "key is not a string");
  assert.equal(refusal({ ...base, action: 3 }), EXPOSURE_ERRORS.invalidParams, "action is not a string");
  assert.equal(refusal({ ...base, extra: 1 }), EXPOSURE_ERRORS.invalidParams, "an unknown field");
  const row = { sidebar: "left", section: "side.count", key: "t1" };
  assert.equal(refusal({ ...row, path: "b", role: "expand" }), EXPOSURE_ERRORS.invalidParams, "path is not an array");
  assert.equal(refusal({ ...row, path: [1], role: "expand" }), EXPOSURE_ERRORS.invalidParams, "path has a value that is not a string");
  assert.equal(refusal({ ...row, path: ["b"], role: "other" }), EXPOSURE_ERRORS.invalidParams, "role is not label or expand");
});

test("a declared status-line address resolves its exact static root", () => {
  const { document: statusDocument } = new JSDOM(`
    <div class="set" data-sidebar="left"><section class="set__section" data-section="demo.tree">
      <div data-expose="core.sidebar.section.status-line" data-key="line-primary" id="project">/project</div>
      <div data-expose="core.sidebar.section.status-line" data-key="line-hint" id="hint">Ready</div>
    </section></div>`).window;
  const statusLines = [...statusDocument.querySelectorAll('[data-expose="core.sidebar.section.status-line"]')];
  assert.equal(typeof sectionAddress.resolveSectionStatusLine, "function", "status-line address resolver is missing");
  const address = { sidebar: "left", section: "demo.tree", key: "line-primary" };
  assert.equal(sectionAddress.resolveSectionStatusLine(address, statusLines), statusDocument.querySelector("#project"));
  assert.throws(() => sectionAddress.resolveSectionStatusLine({ ...address, extra: true }, statusLines),
    { code: EXPOSURE_ERRORS.invalidParams });
  assert.throws(() => sectionAddress.resolveSectionStatusLine({ ...address, key: "line-missing" }, statusLines),
    { code: EXPOSURE_ERRORS.noControl });
});
