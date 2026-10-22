// In an environment with sidecars: false, a plugin that declares sidecars is still a valid reference: its sidecar runs only where the host runs.
import assert from "node:assert/strict";
import test from "node:test";
import { checkReferences, validateEnvironment } from "../index.js";

const environment = (extra = {}) => ({
  runtime: "runtime",
  workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "card", title: "c" }] }] } },
  sidebars: { sets: [], links: [] },
  ...extra,
});
const card = { id: "card", name: "Card", mark: "c", icon: "<path/>", surface: { module: "ui/page.js", composition: { kind: "hybrid", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } },
  dependencies: { "@scope/sidecar-card": "0.1.0" } };
const stateful = { id: "probe", name: "Probe", sections: [{ id: "probe.list", name: "목록", status: "probe.list" }],
  exposes: { status: [{ name: "probe.list", description: "검사용 상태.", schema: { type: "object" } }] }, host: { page: "ui/host.html" },
  dependencies: { "@scope/sidecar-probe": ">=0.1.0 <0.3.0" } };
const plain = { ...stateful };
delete plain.dependencies;

test("sidecars must be a boolean", () => {
  assert.equal(validateEnvironment(environment({ sidecars: false })).sidecars, false);
  assert.throws(() => validateEnvironment(environment({ sidecars: "no" })), /sidecars must be true or false/);
  assert.equal(validateEnvironment(environment({ starter: "starter" })).starter, "starter");
  assert.throws(() => validateEnvironment(environment({ starter: "" })), /starter must be a pack name/);
});

test("install names the registry pack that a build without a host installs, and rejects an empty name", () => {
  assert.throws(() => validateEnvironment(environment({ install: "" })), /install must be a pack name/);
  assert.equal(validateEnvironment(environment({ install: "browser-example" })).install, "browser-example");
});

test("an environment without sidecars accepts plugins that declare sidecars", () => {
  checkReferences(environment({ sidecars: false }), [card, stateful]);
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
