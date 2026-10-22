// Checks that the audit of the running documents fails for a visible view whose page does not expose core.surface.document
// (docs/spec/exposure.md). The surfaces are fixtures in the shape of core.surfaces.
import assert from "node:assert/strict";
import test from "node:test";
import { unauditedViews } from "../../e2e/audit-surfaces.mjs";

const view = (overrides) => ({ surface: "tab-1", plugin: "probe", visible: true, composition: "view", exposes: [], ...overrides });

test("a visible view whose page does not expose core.surface.document is not audited", () => {
  assert.deepEqual(unauditedViews([view({})]).map((surface) => surface.surface), ["tab-1"]);
});

test("a view that exposes core.surface.document, a hidden view and a surface without a view composition are audited by their documents", () => {
  const exposed = view({ surface: "tab-2", exposes: ["status core.surface.document"] });
  const hidden = view({ surface: "tab-3", visible: false });
  const nonView = view({ surface: "tab-4", composition: null });
  assert.deepEqual(unauditedViews([exposed, hidden, nonView]), []);
});
