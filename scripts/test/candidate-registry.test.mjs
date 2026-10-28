import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import * as candidateRegistry from "../check-candidate-registry.mjs";

const { verifyCandidateRegistry } = candidateRegistry;

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const revision = (letter) => letter.repeat(40);
const tree = revision("b");

function fixture() {
  const preservedRevocations = {
    plugins: [{ id: "retired", version: "1.0.0", reason: "Existing reason." }],
    sidecars: [{ name: "old-sidecar", version: "1.0.0", reason: "Existing reason." }],
  };
  const additionalPluginRevocations = [{ id: "legacy", version: "1.1.0", reason: "Removed field." }];
  const index = {
    format: 1,
    plugins: [{ id: "example", versions: [{ version: "1.0.0" }, { version: "1.1.0" }] }],
    sidecars: [{ name: "example-sidecar", versions: [{ version: "2.0.0" }, { version: "2.1.0" }] }],
    core: { versions: [{ version: "0.0.9" }, { version: "0.0.11" }] },
    revoked: {
      plugins: [...structuredClone(preservedRevocations.plugins), ...structuredClone(additionalPluginRevocations)],
      sidecars: structuredClone(preservedRevocations.sidecars),
    },
  };
  const proof = {
    format: 1,
    registrySourceRevision: revision("a"),
    candidateSdk: { sourceRevision: revision("c"), apiVersion: "0.0.21", apiTree: tree },
    indexSha256: "",
    candidateCoreVersion: "0.0.21",
    preservedCoreVersions: ["0.0.9", "0.0.11"],
    preservedCoreJsonSha256: digest(Buffer.from("source core declaration")),
    replacementPlugins: [{ id: "example", version: "1.1.0" }],
    replacementSidecars: [{ name: "example-sidecar", version: "2.1.0" }],
    preservedRevocations,
    additionalPluginRevocations,
    preRevocationRejectedVersions: [{ id: "legacy", version: "1.1.0", field: "surface module" }],
    candidateManifestChecked: 1,
  };
  const indexBytes = Buffer.from(`${JSON.stringify(index)}\n`);
  proof.indexSha256 = digest(indexBytes);
  return { index, proof, indexBytes, proofBytes: Buffer.from(`${JSON.stringify(proof)}\n`) };
}

const identity = { coreVersion: "0.0.21", apiTree: tree };

function gitSdkFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "candidate-sdk-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageDir = join(root, "packages", "plugin-api");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "@soksak/plugin-api", version: "0.0.21" }));
  writeFileSync(join(packageDir, "index.js"), "export const version = '0.0.21';\n");
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "add", "packages/plugin-api/package.json", "packages/plugin-api/index.js"]);
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  return { root, packageDir };
}

test("candidate proof and index pass when SDK and all declared projections match", { timeout: 5000 }, () => {
  const current = fixture();
  assert.deepEqual(verifyCandidateRegistry(current.indexBytes, current.proofBytes, identity), {
    coreVersion: "0.0.21",
    plugins: 1,
    sidecars: 1,
    producerReportedManifestCount: 1,
  });
});

test("both raw digests are checked before parsing either JSON document", { timeout: 5000 }, () => {
  assert.throws(
    () => verifyCandidateRegistry(Buffer.from("not-json"), Buffer.from("also-not-json"), identity, {
      indexSha256: "0".repeat(64),
      proofSha256: "1".repeat(64),
    }),
    /index sha256 .* differs from expected/,
  );
  const current = fixture();
  assert.throws(
    () => verifyCandidateRegistry(current.indexBytes, Buffer.from("not-json"), identity, {
      indexSha256: digest(current.indexBytes),
      proofSha256: "1".repeat(64),
    }),
    /proof sha256 .* differs from expected/,
  );
});

test("the proof index digest binds the exact candidate index bytes", { timeout: 5000 }, () => {
  const current = fixture();
  current.indexBytes = Buffer.concat([current.indexBytes, Buffer.from(" ")]);
  assert.throws(() => verifyCandidateRegistry(current.indexBytes, current.proofBytes, identity), /proof indexSha256/);
});

test("the current SDK identity requires a nonempty version", { timeout: 5000 }, () => {
  const absentIdentity = fixture();
  delete absentIdentity.proof.candidateSdk.apiVersion;
  delete absentIdentity.proof.candidateCoreVersion;
  absentIdentity.proofBytes = Buffer.from(JSON.stringify(absentIdentity.proof));
  assert.throws(() => verifyCandidateRegistry(absentIdentity.indexBytes, absentIdentity.proofBytes, { apiTree: tree }), /current SDK identity/);
});

test("proof revision and digest metadata must be strings", { timeout: 5000 }, () => {
  for (const [mutate, message] of [
    [(proof) => { proof.registrySourceRevision = [revision("a")]; }, /registrySourceRevision must be a full Git commit id/],
    [(proof) => { proof.candidateSdk.sourceRevision = [revision("c")]; }, /sourceRevision must be a full Git commit id/],
    [(proof) => { proof.preservedCoreJsonSha256 = ["a".repeat(64)]; }, /preservedCoreJsonSha256 must be a SHA-256 digest/],
    [(proof) => { proof.candidateSdk.apiTree = [tree]; }, /apiTree must be a full Git tree id/],
    [(proof) => { proof.candidateSdk.apiVersion = ["0.0.21"]; }, /candidate SDK versions must be nonempty strings/],
    [(proof) => { proof.candidateCoreVersion = ["0.0.21"]; }, /candidate SDK versions must be nonempty strings/],
  ]) {
    const current = fixture();
    mutate(current.proof);
    current.proofBytes = Buffer.from(JSON.stringify(current.proof));
    assert.throws(() => verifyCandidateRegistry(current.indexBytes, current.proofBytes, identity), message);
  }
});

test("the SDK identity reader rejects tracked edits and untracked source files", { timeout: 5000 }, (t) => {
  const reader = candidateRegistry.readCurrentIdentity;
  assert.equal(typeof reader, "function", "the SDK identity reader must be testable against a disposable Git checkout");
  const fixtureRoot = gitSdkFixture(t);
  assert.equal(reader(fixtureRoot.root).coreVersion, "0.0.21");
  writeFileSync(join(fixtureRoot.packageDir, "index.js"), "export const version = 'changed';\n");
  assert.throws(() => reader(fixtureRoot.root), /SDK package has uncommitted source changes/);
  writeFileSync(join(fixtureRoot.packageDir, "index.js"), "export const version = '0.0.21';\n");
  writeFileSync(join(fixtureRoot.packageDir, "new-source.js"), "export const source = true;\n");
  assert.throws(() => reader(fixtureRoot.root), /SDK package has uncommitted source changes/);
});

test("the candidate index and proof reject unknown wire formats", { timeout: 5000 }, () => {
  const current = fixture();
  current.index.format = 2;
  current.indexBytes = Buffer.from(JSON.stringify(current.index));
  current.proof.indexSha256 = digest(current.indexBytes);
  current.proofBytes = Buffer.from(JSON.stringify(current.proof));
  assert.throws(() => verifyCandidateRegistry(current.indexBytes, current.proofBytes, identity), /candidate index format 2 is unsupported/);

  current.index.format = 1;
  current.indexBytes = Buffer.from(JSON.stringify(current.index));
  current.proof.indexSha256 = digest(current.indexBytes);
  current.proof.format = 2;
  current.proofBytes = Buffer.from(JSON.stringify(current.proof));
  assert.throws(() => verifyCandidateRegistry(current.indexBytes, current.proofBytes, identity), /candidate proof format 2 is unsupported/);
});

test("the proof must match the current SDK version and HEAD API tree", { timeout: 5000 }, () => {
  for (const mutate of [
    (proof) => { proof.candidateSdk.apiVersion = "0.0.20"; },
    (proof) => { proof.candidateSdk.apiTree = revision("e"); },
    (proof) => { proof.candidateSdk.sourceRevision = "short"; },
    (proof) => { proof.candidateCoreVersion = "0.0.20"; },
  ]) {
    const current = fixture();
    mutate(current.proof);
    current.proofBytes = Buffer.from(JSON.stringify(current.proof));
    assert.throws(() => verifyCandidateRegistry(current.indexBytes, current.proofBytes, identity), /candidate SDK/);
  }
});

test("the candidate core and preserved core projection must match the index", { timeout: 5000 }, () => {
  for (const [owner, mutate] of [
    ["index", (value) => { value.core.versions[0].version = "0.0.8"; }],
    ["index", (value) => { value.core.versions.push({ version: "0.0.21" }); }],
    ["proof", (value) => { value.preservedCoreVersions.push("0.0.12"); }],
  ]) {
    const current = fixture();
    mutate(current[owner]);
    current.indexBytes = Buffer.from(JSON.stringify(current.index));
    current.proof.indexSha256 = digest(current.indexBytes);
    current.proofBytes = Buffer.from(JSON.stringify(current.proof));
    assert.throws(() => verifyCandidateRegistry(current.indexBytes, current.proofBytes, identity), /core/);
  }
});

test("replacement identities and versions must be present in the candidate index", { timeout: 5000 }, () => {
  for (const mutate of [
    (proof) => { proof.replacementPlugins[0].version = "9.9.9"; },
    (proof) => { proof.replacementSidecars[0].name = "missing"; },
    (proof) => { proof.replacementPlugins = []; },
  ]) {
    const current = fixture();
    mutate(current.proof);
    current.proofBytes = Buffer.from(JSON.stringify(current.proof));
    assert.throws(() => verifyCandidateRegistry(current.indexBytes, current.proofBytes, identity), /replacement/);
  }
});

test("a candidate with no sidecar replacements still requires a nonempty plugin manifest check", { timeout: 5000 }, () => {
  const current = fixture();
  current.proof.replacementSidecars = [];
  current.index.sidecars[0].versions = [{ version: "2.0.0" }];
  current.indexBytes = Buffer.from(JSON.stringify(current.index));
  current.proof.indexSha256 = digest(current.indexBytes);
  current.proofBytes = Buffer.from(JSON.stringify(current.proof));
  assert.deepEqual(verifyCandidateRegistry(current.indexBytes, current.proofBytes, identity), {
    coreVersion: "0.0.21",
    plugins: 1,
    sidecars: 0,
    producerReportedManifestCount: 1,
  });
});

test("revocation projection and exact manifest count must agree", { timeout: 5000 }, () => {
  for (const [owner, mutate] of [
    ["index", (value) => { value.revoked.plugins[0].reason = "Changed."; }],
    ["index", (value) => { value.revoked.core = [{ version: "0.0.10", reason: "Unexpected." }]; }],
    ["index", (value) => { value.revoked.unexpected = []; }],
    ["proof", (value) => { value.preRevocationRejectedVersions = []; }],
    ["proof", (value) => { value.candidateManifestChecked = 0; }],
  ]) {
    const current = fixture();
    if (owner === "index") {
      mutate(current.index);
      current.indexBytes = Buffer.from(JSON.stringify(current.index));
      current.proof.indexSha256 = digest(current.indexBytes);
    } else {
      mutate(current.proof);
    }
    current.proofBytes = Buffer.from(JSON.stringify(current.proof));
    assert.throws(() => verifyCandidateRegistry(current.indexBytes, current.proofBytes, identity), /revocation|revoked|Manifest/);
  }
});

test("an absent or empty core revocation list is equivalent and nonempty entries must match", { timeout: 5000 }, () => {
  const current = fixture();
  current.index.revoked.core = [];
  current.proof.preservedRevocations.core = [];
  current.indexBytes = Buffer.from(JSON.stringify(current.index));
  current.proof.indexSha256 = digest(current.indexBytes);
  current.proofBytes = Buffer.from(JSON.stringify(current.proof));
  assert.doesNotThrow(() => verifyCandidateRegistry(current.indexBytes, current.proofBytes, identity));

  const withdrawn = { version: "0.0.10", reason: "Withdrawn." };
  current.index.revoked.core = [structuredClone(withdrawn)];
  current.proof.preservedRevocations.core = [structuredClone(withdrawn)];
  current.indexBytes = Buffer.from(JSON.stringify(current.index));
  current.proof.indexSha256 = digest(current.indexBytes);
  current.proofBytes = Buffer.from(JSON.stringify(current.proof));
  assert.doesNotThrow(() => verifyCandidateRegistry(current.indexBytes, current.proofBytes, identity));

  current.index.revoked.core[0].reason = "Changed.";
  current.indexBytes = Buffer.from(JSON.stringify(current.index));
  current.proof.indexSha256 = digest(current.indexBytes);
  current.proofBytes = Buffer.from(JSON.stringify(current.proof));
  assert.throws(() => verifyCandidateRegistry(current.indexBytes, current.proofBytes, identity), /revocation projection/);

  delete current.index.revoked.core;
  current.indexBytes = Buffer.from(JSON.stringify(current.index));
  current.proof.indexSha256 = digest(current.indexBytes);
  current.proofBytes = Buffer.from(JSON.stringify(current.proof));
  assert.throws(() => verifyCandidateRegistry(current.indexBytes, current.proofBytes, identity), /revocation projection/);

  delete current.proof.preservedRevocations.core;
  current.proofBytes = Buffer.from(JSON.stringify(current.proof));
  assert.doesNotThrow(() => verifyCandidateRegistry(current.indexBytes, current.proofBytes, identity));

  current.proof.preservedRevocations.core = [{ version: "0.0.10", reason: "Withdrawn." }];
  current.proofBytes = Buffer.from(JSON.stringify(current.proof));
  assert.throws(() => verifyCandidateRegistry(current.indexBytes, current.proofBytes, identity), /revocation projection/);
});

test("the CLI requires explicit index and proof URLs with SHA-256 pins", { timeout: 5000 }, (t) => {
  const folder = mkdtempSync(join(tmpdir(), "candidate-registry-cli-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const script = new URL("../check-candidate-registry.mjs", import.meta.url);
  const missing = spawnSync(process.execPath, [script.pathname], { encoding: "utf8", timeout: 4000 });
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stdout}${missing.stderr}`, /--index.*--index-sha256.*--proof.*--proof-sha256/);

  const current = fixture();
  const indexPath = join(folder, "index.json");
  const proofPath = join(folder, "proof.json");
  writeFileSync(indexPath, current.indexBytes);
  writeFileSync(proofPath, current.proofBytes);
  const apiTree = execFileSync("git", ["rev-parse", "HEAD:packages/plugin-api"], { encoding: "utf8" }).trim();
  const manifest = JSON.parse(readFileSync(new URL("../../packages/plugin-api/package.json", import.meta.url), "utf8"));
  current.proof.candidateSdk.apiVersion = manifest.version;
  current.proof.candidateSdk.apiTree = apiTree;
  current.proof.candidateCoreVersion = manifest.version;
  current.proofBytes = Buffer.from(JSON.stringify(current.proof));
  writeFileSync(proofPath, current.proofBytes);
  const indexUrl = pathToFileURL(indexPath).href;
  const proofUrl = pathToFileURL(proofPath).href;
  const result = spawnSync(process.execPath, [script.pathname,
    "--index", indexUrl, "--index-sha256", digest(current.indexBytes),
    "--proof", proofUrl, "--proof-sha256", digest(current.proofBytes),
  ], { encoding: "utf8", timeout: 4000 });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /Candidate registry proof check passed/);
  assert.match(result.stdout, /producer-reported manifest count 1/);
});
