// The version text of a catalog row leaves out a version that is not known (docs/spec/settings.md#plugins).
import assert from "node:assert/strict";
import test from "node:test";
import { versionText } from "../settings-plugins.js";

test("a catalog row without a latest or installed version shows no version text", () => {
  assert.equal(versionText({ id: "a", latest: null, installed: null, incompatible: false }), "");
});

test("a catalog row shows its latest version, then its installed version", () => {
  assert.equal(versionText({ id: "a", latest: "1.2.0", installed: null, incompatible: false }), "v1.2.0");
  assert.equal(versionText({ id: "a", latest: null, installed: { version: "1.0.0" }, incompatible: false }), "v1.0.0");
});
