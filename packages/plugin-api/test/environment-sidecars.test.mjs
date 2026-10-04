// sidecars: false 환경에서 설치된 플러그인의 상태 모듈이 사이드카를 쓰면 로드가 실패한다.
import assert from "node:assert/strict";
import test from "node:test";
import { checkReferences, validateEnvironment } from "../index.js";

const environment = (extra = {}) => ({
  runtime: "runtime",
  workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "card", title: "c" }] }] } },
  sidebars: { sets: [], links: [] },
  ...extra,
});
const card = { id: "card", name: "Card", mark: "c", icon: "<path/>", surface: { module: "ui/page.js", composition: { kind: "dom" } },
  dependencies: { "@scope/sidecar-card": "0.1.0" } };
const stateful = { id: "probe", name: "Probe", sections: [{ id: "probe.list", name: "목록", module: "ui/list.js" }],
  state: { module: "ui/state.js" }, dependencies: { "@scope/sidecar-probe": ">=0.1.0 <0.3.0" } };
const plain = { ...stateful };
delete plain.dependencies;

test("sidecars must be a boolean", () => {
  assert.equal(validateEnvironment(environment({ sidecars: false })).sidecars, false);
  assert.throws(() => validateEnvironment(environment({ sidecars: "no" })), /sidecars must be true or false/);
  assert.equal(validateEnvironment(environment({ starter: "starter" })).starter, "starter");
  assert.throws(() => validateEnvironment(environment({ starter: "" })), /starter must be a pack name/);
});

test("an environment without sidecars rejects a state module that uses sidecars and accepts surfaces with sidecars", () => {
  assert.throws(() => checkReferences(environment({ sidecars: false }), [card, stateful]),
    /plugin probe has a state module that uses sidecars, which this environment cannot run/);
  checkReferences(environment({ sidecars: false }), [card, plain]);
  checkReferences(environment(), [card, stateful]);
});

test("the default registry is an https: or absolute file: URL", () => {
  for (const registry of ["https://soksak-app.github.io/registry/index.json", "file:///registry/index.json"]) {
    assert.equal(validateEnvironment(environment({ registry })).registry, registry);
  }
  for (const registry of ["", "http://example.invalid/index.json", "registry/index.json", "file:registry/index.json", 3]) {
    assert.throws(() => validateEnvironment(environment({ registry })),
      /^Error: environment\.json: registry must be an https: or absolute file: URL$/, String(registry));
  }
});
