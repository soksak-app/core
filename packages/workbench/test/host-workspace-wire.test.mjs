// The workspace calls of the host store answer the page-wire cases workspace-settings-common, workspace-settings-unknown-project and
// workspace-snapshot (docs/spec/cases/page-wire/README.md). The native host runs each case with replay true.
import assert from "node:assert/strict";
import { test } from "node:test";
import { host, selectPageWire } from "@soksak/runtime";
import { HostWorkspaceStore } from "../host-store.js";

test("a settings write without a project identifier writes the common settings and sends no identifier", async () => {
  const wire = selectPageWire("workspace-settings-common");
  const store = new HostWorkspaceStore(host);
  await store.settings(undefined, { gap: 8, radius: undefined }, ["p1.9"]);
  wire.finish();
});

test("a settings write for a project the registry does not hold is refused with the unknown project error", async () => {
  const wire = selectPageWire("workspace-settings-unknown-project");
  const store = new HostWorkspaceStore(host);
  await assert.rejects(store.settings("prj", { gap: 8, radius: undefined }, ["p1.9"]), /unknown project: prj/);
  wire.finish();
});

test("the snapshot answers the common settings, the projects and the open identifiers", async () => {
  const wire = selectPageWire("workspace-snapshot");
  const store = new HostWorkspaceStore(host);
  assert.deepEqual(await store.snapshot(), { common: {}, pluginData: {}, projects: [], open: [] });
  wire.finish();
});
