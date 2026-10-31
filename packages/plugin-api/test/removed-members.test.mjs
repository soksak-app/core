// The members that the section form removed: plugin.json `host` and `hostOperations`, and sidecar.json `hostReadOperations`
// (docs/spec/plugins.md#pluginjson, docs/spec/sidecars.md#declaration-and-startup). The fixtures use probe and fixture-* names only.
import assert from "node:assert/strict";
import test from "node:test";
import { validateManifest, validateSidecar } from "../index.js";

const plugin = {
  id: "probe", name: "Probe", description: "A probe fixture plugin.", mark: "p", icon: "<path/>",
  surface: { composition: { kind: "view", page: "ui/page.html" } },
  dependencies: { "fixture-sidecar": ">=0.1.0 <0.3.0" },
};
const sidecar = {
  executable: "build/worker", displayName: "soksak://sidecar/fixture", protocol: 1,
  message: { form: "json-object", operationField: "operation" },
};

test("a plugin host member is refused as removed", () => {
  assert.throws(() => validateManifest({ ...plugin, host: { page: "ui/host.html" } }), {
    message: "plugin probe: host is removed; a section is a view of the plugin",
  });
});

test("the hostOperations member is refused as removed", () => {
  assert.throws(() => validateManifest({ ...plugin, hostOperations: { "fixture-sidecar": ["list"] } }), {
    message: "plugin probe: hostOperations is removed; a section is a view of the plugin",
  });
});

test("a sidecar declares its message form and no host read operations", () => {
  assert.equal(validateSidecar(sidecar), sidecar);
  assert.throws(() => validateSidecar({ ...sidecar, message: { form: "text", operationField: "operation" } }),
    /message form must be json-object/);
  assert.throws(() => validateSidecar({ ...sidecar, message: { form: "json-object", operationField: "" } }),
    /message operationField must be a field name/);
  assert.throws(() => validateSidecar({ ...sidecar, hostReadOperations: ["list"] }), {
    message: "sidecar.json: hostReadOperations is removed",
  });
});
