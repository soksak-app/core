// Checks that the release check reports every installed plugin version whose manifest the new core rejects.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registryManifestErrors } from "../check-registry-manifests.mjs";

const good = { id: "probe", name: "Probe", description: "Fixture plugin.", sections: [{ id: "probe.list", name: "List", module: "ui/list.js" }] };

/** A plugin release with manifest at its root, as `sok plugin pack` writes it. */
function release(t, manifest) {
  const folder = mkdtempSync(join(tmpdir(), "registry-manifest-fixture-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, "plugin.json"), JSON.stringify(manifest));
  writeFileSync(join(folder, "package.json"), "{}");
  execFileSync("tar", ["-czf", join(folder, "plugin.tgz"), "-C", folder, "package.json", "plugin.json"]);
  return readFileSync(join(folder, "plugin.tgz"));
}

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("each plugin version that the new core installs and whose manifest it rejects is reported", async (t) => {
  const accepted = release(t, good);
  const rejected = release(t, { ...good, panel: true });
  const releases = new Map([["a", accepted], ["b", rejected], ["c", accepted], ["d", rejected], ["e", rejected]]);
  const version = (v, key, range, digest = sha(releases.get(key))) => ({
    version: v, package: { url: key, sha256: digest }, engines: { soksak: range }, sidecars: {},
  });
  const index = {
    plugins: [{ id: "probe", versions: [
      version("0.0.1", "a", "*"),
      version("0.0.2", "b", ">=0.0.5"),
      version("0.0.3", "c", "^0.0.6", "0".repeat(64)),
      version("0.0.4", "d", "^0.0.4"),
      version("0.0.5", "e", "*"),
    ] }],
    revoked: { plugins: [{ id: "probe", version: "0.0.5", reason: "Fixture." }], sidecars: [] },
  };
  const { checked, errors } = await registryManifestErrors(index, "0.0.6", async (url) => releases.get(url));
  assert.equal(checked, 3, "0.0.4 is outside its range and 0.0.5 is revoked");
  assert.deepEqual(errors, [
    "plugin probe 0.0.2: plugin.json: unknown field panel",
    `plugin probe 0.0.3: release sha256 ${sha(accepted)} differs from the index ${"0".repeat(64)}`,
  ]);
});
