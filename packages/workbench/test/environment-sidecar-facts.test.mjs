// The environment gives the plugin host the sidecar facts of the installed document, so the main page checks a sidecar request
// against the sidecar.json of the sidecar (docs/plans/plugin-host-routes.md rule 8). The fixtures use the names probe and fixture-* only.
import assert from "node:assert/strict";
import test from "node:test";

const SIDECAR = "@fixture/sidecar-probe";
const manifest = {
  id: "probe", name: "Probe", description: "검사용 플러그인 호스트.",
  mark: "p", icon: "<path/>", surface: { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } },
  host: { page: "ui/host.html" },
  dependencies: { [SIDECAR]: "^0.1.0" },
  hostOperations: { [SIDECAR]: ["list"] },
};
const facts = { message: { form: "json-object", operationField: "operation" }, hostReadOperations: ["list"] };
const installed = { plugins: [{ id: "probe", package: "@fixture/probe", version: "0.1.0", manifest, sidecars: { [SIDECAR]: facts } }] };
const environmentFile = {
  runtime: "runtime",
  workspace: { focus: "main", grid: { xs: [0, 1], ys: [0, 1], cards: [{ id: "main", c0: 0, c1: 1, r0: 0, r1: 1, tabs: [{ plugin: "probe", title: "probe" }] }] } },
  sidebars: { sets: [], links: [] },
};

test("the environment declares the sidecar facts of the installed document to the plugin host", async () => {
  const { installEnvironment } = await import("../environment.js");
  const { checkHostSidecarRequest, pluginSidecarsOf } = await import("../plugin-host.js");
  installEnvironment(structuredClone(environmentFile), structuredClone(installed));
  const [sidecar] = pluginSidecarsOf("probe");
  assert.deepEqual(sidecar, { name: SIDECAR, declared: ["list"], declaration: facts });
  assert.equal(checkHostSidecarRequest({ plugin: "probe", sidecar: SIDECAR, declared: sidecar.declared, sidecarDeclaration: sidecar.declaration,
    body: { operation: "list", path: "a" } }), '{"operation":"list","path":"a"}');
  assert.throws(() => checkHostSidecarRequest({ plugin: "probe", sidecar: SIDECAR, declared: sidecar.declared, sidecarDeclaration: sidecar.declaration,
    body: { operation: "write" } }), { message: "plugin host probe: operation write is not served" });
});
