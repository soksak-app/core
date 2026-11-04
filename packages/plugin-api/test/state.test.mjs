// Checks the project data declaration of a plugin, and the refusal of the removed state module.
import assert from "node:assert/strict";
import test from "node:test";
import { checkProjectData, validateManifest } from "../index.js";

const base = () => ({
  id: "probe", name: "Probe", description: "검사용 플러그인.",
  sections: [{ id: "probe.marks", name: "Marks", composition: { kind: "view", page: "ui/page.html" }, height: "fill" }],
  dependencies: { "@scope/sidecar-probe": "~0.4.1" },
  data: { marks: { schema: { type: "array", items: { type: "string" } }, default: [] } },
  exposes: { status: [{ name: "probe.marks", description: "Marks.", schema: { type: "array" } }], commands: [], element: [] },
});

test("a section view may declare project data, sidecars, and exposes", () => {
  const manifest = base();
  assert.equal(validateManifest(manifest), manifest);
});

test("the state module is refused with the plugin and the field", () => {
  assert.throws(() => validateManifest({ ...base(), state: { module: "ui/state.js" } }),
    { message: "plugin probe: state is removed; a plugin declares its project data with data (docs/spec/plugins.md#project-data)" });
});

test("data and sidecars are rejected when their requirements are missing", () => {
  const without = (key) => { const m = base(); delete m[key]; return m; };
  const cases = [
    [{ ...without("sections"), exposes: undefined }, /data requires a surface or sections/],
    [{ ...without("sections"), data: undefined, exposes: undefined }, /dependencies require a surface, sections or contributes/],
    [{ ...base(), data: { marks: { schema: { type: "array" }, default: "x" } } }, /data marks default does not match its schema/],
    [{ ...base(), data: { marks: { schema: { type: "array" } } } }, /data marks requires schema and default/],
  ];
  for (const [manifest, message] of cases) {
    if (manifest.data === undefined) delete manifest.data;
    assert.throws(() => validateManifest(manifest), message);
  }
});

test("project data is accepted for a section view", () => {
  const manifest = base();
  assert.equal(validateManifest(manifest), manifest);
  assert.equal(validateManifest(manifest).data.marks.default.length, 0);
});

test("checkProjectData accepts declared values and rejects undeclared keys and mismatches", () => {
  const { data } = base();
  assert.deepEqual(checkProjectData("probe", data, "marks", ["a"]), ["a"]);
  assert.throws(() => checkProjectData("probe", data, "other", []), /probe data other is not declared/);
  assert.throws(() => checkProjectData("probe", data, "marks", [1]), /probe data marks does not match its schema/);
});

test("a data key declares an optional positive integer format", () => {
  const withFormat = (format) => ({ ...base(), data: { marks: { ...base().data.marks, format } } });
  assert.equal(validateManifest(withFormat(2)).data.marks.format, 2);
  for (const format of [0, 1.5, "2", null]) {
    assert.throws(() => validateManifest(withFormat(format)), /data marks format must be a positive integer/);
  }
});
