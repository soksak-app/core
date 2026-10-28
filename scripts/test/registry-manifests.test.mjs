// Checks that the release check reports every installed plugin version whose manifest the new core rejects.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { registryManifestErrors } from "../check-registry-manifests.mjs";

const good = {
  id: "probe", name: "Probe", description: "Fixture plugin.", host: { page: "ui/host.html" },
  exposes: { status: [{ name: "probe.list", description: "Fixture status.", schema: { type: "object" } }] },
  sections: [{ id: "probe.list", name: "List", status: "probe.list" }],
};

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

const script = new URL("../check-registry-manifests.mjs", import.meta.url);

function runCLI(args) {
  const result = spawnSync(process.execPath, [script.pathname, ...args], { encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error);
  return result;
}

test("each plugin version that the new core installs and whose manifest it rejects is reported", async (t) => {
  const accepted = release(t, good);
  const rejected = release(t, { ...good, panel: true });
  const releases = new Map([["a", accepted], ["b", rejected], ["c", accepted], ["d", rejected], ["e", rejected]]);
  const version = (v, key, range, digest = sha(releases.get(key))) => ({
    version: v, release: { url: key, sha256: digest }, engines: { soksak: range }, sidecars: {},
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

test("an explicit index remains supported without a sha256", { timeout: 5000 }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "registry-index-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "index.json");
  const bytes = Buffer.from(JSON.stringify({ format: 1, plugins: [], sidecars: [], packs: [], revoked: { plugins: [], sidecars: [] } }));
  writeFileSync(path, bytes);

  const result = runCLI(["--index", pathToFileURL(path).href]);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /manifest check passed/);
});

test("an expected index sha256 requires an explicit nonempty index URL", { timeout: 5000 }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "registry-index-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "index.json");
  const bytes = Buffer.from("{}");
  writeFileSync(path, bytes);
  const digest = sha(bytes);

  const missing = runCLI(["--sha256", digest]);
  assert.notEqual(missing.status, 0, `${missing.stdout}${missing.stderr}`);
  assert.match(`${missing.stdout}${missing.stderr}`, /--sha256 requires --index/);

  const empty = runCLI(["--index", "", "--sha256", digest]);
  assert.notEqual(empty.status, 0, `${empty.stdout}${empty.stderr}`);
  assert.match(`${empty.stdout}${empty.stderr}`, /--index must be a nonempty URL/);
});

test("the explicit index sha256 must be 64 lowercase hexadecimal characters", { timeout: 5000 }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "registry-index-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "index.json");
  writeFileSync(path, "{}");
  const url = pathToFileURL(path).href;

  for (const digest of ["ABCDEF", "g".repeat(64), "a".repeat(63), "a".repeat(65)]) {
    const result = runCLI(["--index", url, "--sha256", digest]);
    assert.notEqual(result.status, 0, `${digest}: ${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, /--sha256 must be 64 lowercase hexadecimal characters/);
  }
});

test("the explicit index sha256 is checked before parsing index bytes", { timeout: 5000 }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "registry-index-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "index.json");
  const bytes = Buffer.from("not-json");
  writeFileSync(path, bytes);
  const result = runCLI(["--index", pathToFileURL(path).href, "--sha256", "0".repeat(64)]);

  assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(`${result.stdout}${result.stderr}`, /index sha256 .* differs from expected/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /JSON|Unexpected token/);
});

test("the explicit index is accepted when its sha256 matches", { timeout: 5000 }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "registry-index-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "index.json");
  const bytes = Buffer.from(JSON.stringify({ format: 1, plugins: [], sidecars: [], packs: [], revoked: { plugins: [], sidecars: [] } }));
  writeFileSync(path, bytes);
  const result = runCLI(["--index", pathToFileURL(path).href, "--sha256", sha(bytes)]);

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /manifest check passed/);
});
