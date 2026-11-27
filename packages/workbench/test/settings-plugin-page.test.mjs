// The sidecar line of a plugin page names each sidecar with its range, or 없음 (docs/spec/settings.md#plugin-page).
import assert from "node:assert/strict";
import test from "node:test";
import { sidecarText } from "../settings-plugins.js";

test("a plugin without sidecars shows 없음", () => {
  assert.equal(sidecarText([]), "없음");
});

test("a plugin page names each sidecar with its range, and a sidecar without a range by its name", () => {
  assert.equal(sidecarText([{ name: "hello", range: "^2.0.0" }, { name: "probe", range: null }]), "hello ^2.0.0, probe");
});
