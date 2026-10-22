// The operations that a plugin host may call on a sidecar (docs/spec/plugins.md#pluginjson, docs/spec/sidecars.md#messages).
// The fixtures use the names probe and fixture-* only: core names no real plugin or sidecar.
import assert from "node:assert/strict";
import test from "node:test";
import { checkHostOperations, validateManifest, validateSidecar } from "../index.js";

const host = { page: "ui/host.js" };
const plugin = {
  id: "probe", name: "Probe", description: "A probe fixture plugin.", mark: "p", icon: "<path/>",
  host,
  exposes: { status: [{ name: "probe.list", description: "A probe status.", schema: { type: "object" } }] },
  sections: [{ id: "probe.list", name: "List", status: "probe.list" }],
  dependencies: { "fixture-sidecar": ">=0.1.0 <0.3.0" },
  hostOperations: { "fixture-sidecar": ["list", "stat"] },
};
const sidecar = {
  executable: "build/worker", protocol: 1,
  message: { form: "json-object", operationField: "operation" },
  hostReadOperations: ["list", "stat"],
};

test("a plugin host declares the operations it may call per sidecar dependency", () => {
  assert.doesNotThrow(() => validateManifest(plugin));
});

test("hostOperations needs a plugin host and a declared dependency", () => {
  const { host: _unused, ...withoutHost } = plugin;
  // A contributor without a host is valid through its contributions, so the manifest passes the dependency rule.
  const contributor = { id: "probe", name: "Probe", description: "A probe fixture plugin.", dependencies: withoutHost.dependencies, hostOperations: withoutHost.hostOperations,
    contributes: { "fixture.point": [{ range: "^1.0.0", module: "ui/tidy.js" }] } };
  assert.throws(() => validateManifest(contributor), /hostOperations requires host/);
  assert.throws(() => validateManifest({ ...plugin, hostOperations: { "fixture-other": ["list"] } }),
    /hostOperations fixture-other is not a dependency/);
});

test("hostOperations lists non-empty unique operation names as an array", () => {
  for (const value of ["list", [], [""], ["list", "list"], [1], [null]]) {
    assert.throws(() => validateManifest({ ...plugin, hostOperations: { "fixture-sidecar": value } }),
      /hostOperations fixture-sidecar must be a list of distinct operation names/);
  }
  assert.throws(() => validateManifest({ ...plugin, hostOperations: [] }), /hostOperations must map sidecars to operations/);
});

test("a sidecar declares its message form and the operations a plugin host may call", () => {
  assert.equal(validateSidecar(sidecar), sidecar);
  assert.throws(() => validateSidecar({ ...sidecar, message: { form: "text", operationField: "operation" } }),
    /message form must be json-object/);
  assert.throws(() => validateSidecar({ ...sidecar, message: { form: "json-object", operationField: "" } }),
    /message operationField must be a field name/);
  assert.throws(() => validateSidecar({ ...sidecar, hostReadOperations: ["list", "list"] }),
    /hostReadOperations must be a list of distinct operation names/);
});

test("checkHostOperations refuses a declared operation that the sidecar does not declare for hosts", () => {
  assert.doesNotThrow(() => checkHostOperations(plugin, { "fixture-sidecar": sidecar }));
  assert.throws(() => checkHostOperations({ ...plugin, hostOperations: { "fixture-sidecar": ["write"] } }, { "fixture-sidecar": sidecar }),
    /hostOperations fixture-sidecar: operation write is not in hostReadOperations/);
  assert.throws(() => checkHostOperations(plugin, { "fixture-sidecar": { ...sidecar, hostReadOperations: undefined } }),
    /hostOperations fixture-sidecar: operation list is not in hostReadOperations/);
  assert.throws(() => checkHostOperations(plugin, {}), /hostOperations fixture-sidecar: sidecar.json is missing/);
});
