// 표면 없는 플러그인의 상태 모듈과 프로젝트 데이터 선언을 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { checkProjectData, validateManifest } from "../index.js";

const base = () => ({
  id: "probe", name: "Probe", description: "검사용 플러그인.",
  sections: [{ id: "probe.list", name: "목록", module: "ui/list.js" }],
  state: { module: "ui/state.js" },
  sidecars: ["@scope/sidecar-probe"],
  data: { marks: { schema: { type: "array", items: { type: "string" } }, default: [] } },
  exposes: { status: [{ name: "probe.marks", description: "Marks.", schema: { type: "array" } }], commands: [], dom: [] },
});

test("a sections-only plugin may declare a state module, sidecars, project data, and exposes", () => {
  const manifest = base();
  assert.equal(validateManifest(manifest), manifest);
});

test("state, data, and sidecars are rejected when their requirements are missing", () => {
  const without = (key) => { const m = base(); delete m[key]; return m; };
  const cases = [
    [{ ...base(), state: { module: "/abs.js" } }, /state module must be a JavaScript path/],
    [{ ...base(), state: { module: "ui/state.js", extra: 1 } }, /unknown field extra/],
    [without("sections"), /state requires sections/],
    [{ ...without("state"), data: base().data }, /data requires a state module/],
    [{ ...without("state"), data: undefined }, /sidecars require a surface or a state module/],
    [{ ...base(), data: { marks: { schema: { type: "array" }, default: "x" } } }, /data marks default does not match its schema/],
    [{ ...base(), data: { marks: { schema: { type: "array" } } } }, /data marks requires schema and default/],
  ];
  for (const [manifest, message] of cases) {
    if (manifest.data === undefined) delete manifest.data;
    assert.throws(() => validateManifest(manifest), message);
  }
});

test("checkProjectData accepts declared values and rejects undeclared keys and mismatches", () => {
  const { data } = base();
  assert.deepEqual(checkProjectData("probe", data, "marks", ["a"]), ["a"]);
  assert.throws(() => checkProjectData("probe", data, "other", []), /probe data other is not declared/);
  assert.throws(() => checkProjectData("probe", data, "marks", [1]), /probe data marks does not match its schema/);
});
