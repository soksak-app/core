// Checks the manifest member sessions: a plugin whose surfaces may open owned sessions declares it with a surface and exactly one
// sidecar in dependencies (docs/spec/plugins.md#pluginjson, docs/spec/plugins.md#owned-sessions).
import assert from "node:assert/strict";
import test from "node:test";
import { validateManifest } from "../index.js";

const page = { composition: { kind: "view", page: "ui/page.html", regions: [{ name: "page", kind: "document", input: "native" }], overlays: [] } };
const base = {
  id: "fixture-session", name: "Session", description: "검사용 플러그인.", mark: "s", icon: "<path/>",
  surface: page,
  dependencies: { "@scope/fixture-sidecar": "1.0.0" },
};

test("a plugin with a surface and one sidecar declares sessions as true", () => {
  assert.equal(validateManifest({ ...base, sessions: true }).sessions, true);
});

test("sessions must be true", () => {
  assert.throws(() => validateManifest({ ...base, sessions: "yes" }), /sessions must be true/);
  assert.throws(() => validateManifest({ ...base, sessions: false }), /sessions must be true/);
});

test("sessions requires a surface, because the surface is the owner of a session", () => {
  const { surface, dependencies, ...withoutSurface } = base;
  assert.throws(() => validateManifest({ ...withoutSurface, sessions: true }), /sessions requires a surface/);
});

test("sessions requires exactly one declared sidecar in dependencies", () => {
  assert.throws(() => validateManifest({ ...base, dependencies: {}, sessions: true }), /sessions requires one sidecar/);
  assert.throws(() => validateManifest({ ...base, dependencies: { "@scope/a": "1.0.0", "@scope/b": "1.0.0" }, sessions: true }),
    /sessions requires one sidecar/);
});
