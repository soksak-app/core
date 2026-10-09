import assert from "node:assert/strict";
import test from "node:test";
import { parseOptions, releaseKey, withCore } from "../check-app-update.mjs";

test("the options name the host, the bundle and the registry index", () => {
  assert.deepEqual(parseOptions(["--host", "tauriv2", "--bundle", "b.app", "--registry", "i.json"]), { host: "tauriv2", bundle: "b.app", registry: "i.json" });
  assert.throws(() => parseOptions(["--host", "other", "--bundle", "b", "--registry", "i"]), /--host must be wailsv3 or tauriv2/);
  assert.throws(() => parseOptions(["--host", "wailsv3", "--bundle", "b"]), /--registry is required/);
  assert.throws(() => parseOptions(["--host", "wailsv3", "--bundle", "--registry", "i"]), /--bundle requires a value/);
  assert.throws(() => parseOptions(["--host", "wailsv3", "--bundle", "b", "--registry", "i", "--other", "x"]), /unknown option --other/);
});

test("the release key joins the platform, the architecture and the host", () => {
  assert.equal(releaseKey("wailsv3", "arm64"), "darwin-arm64-wailsv3");
  assert.equal(releaseKey("tauriv2", "x64"), "darwin-x64-tauriv2");
});

test("the index lists one newer core release for the key and keeps the rest", () => {
  const index = withCore({ format: 1, plugins: [] }, "darwin-arm64-wailsv3", "file:///r.zip", "0".repeat(64));
  assert.deepEqual(index, {
    format: 1,
    plugins: [],
    core: { versions: [{ version: "99.0.0", releases: { "darwin-arm64-wailsv3": { url: "file:///r.zip", sha256: "0".repeat(64) } } }] },
  });
});
