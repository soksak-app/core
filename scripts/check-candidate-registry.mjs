#!/usr/bin/env node
// Verifies a pinned candidate registry index and its producer proof against this core SDK checkout.
//   node scripts/check-candidate-registry.mjs --index URL --index-sha256 HASH --proof URL --proof-sha256 HASH
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isDeepStrictEqual } from "node:util";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HASH = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const FETCH_TIMEOUT_MS = 15_000;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fail(message) {
  throw new Error(message);
}

function object(value, where) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${where} must be an object`);
  return value;
}

function array(value, where) {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  return value;
}

function onlyKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${where} has unsupported field ${key}`);
  }
}

function uniqueVersions(values, where) {
  const seen = new Set();
  for (const value of array(values, where)) {
    if (typeof value !== "string" || value === "") fail(`${where} contains an invalid version`);
    if (seen.has(value)) fail(`${where} repeats version ${value}`);
    seen.add(value);
  }
  return values;
}

function candidateIdentities(values, field, where) {
  const seen = new Set();
  for (const value of array(values, where)) {
    object(value, where);
    if (typeof value[field] !== "string" || value[field] === "" || typeof value.version !== "string" || value.version === "") {
      fail(`${where} contains an invalid ${field}/version identity`);
    }
    const identity = `${value[field]}@${value.version}`;
    if (seen.has(identity)) fail(`${where} repeats ${identity}`);
    seen.add(identity);
  }
  return values;
}

function parseBytes(bytes, label) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    fail(`candidate ${label} JSON: ${error.message}`);
  }
}

function verifyReplacementProjection(index, proof, field, indexField, where, requireNonempty = false) {
  const replacements = candidateIdentities(proof[field], indexField, `candidate proof ${field}`);
  if (requireNonempty && replacements.length === 0) fail(`candidate proof ${field} must not be empty`);
  const entries = array(index[indexField === "id" ? "plugins" : "sidecars"], `candidate index ${indexField === "id" ? "plugins" : "sidecars"}`);
  const byName = new Map();
  for (const entry of entries) {
    object(entry, `candidate index ${where}`);
    const name = entry[indexField];
    if (typeof name !== "string" || name === "") fail(`candidate index ${where} entry has no ${indexField}`);
    if (byName.has(name)) fail(`candidate index ${where} repeats ${name}`);
    byName.set(name, entry);
  }
  for (const replacement of replacements) {
    const entry = byName.get(replacement[indexField]);
    if (!entry) fail(`candidate index is missing replacement ${where} ${replacement[indexField]}@${replacement.version}`);
    const versions = uniqueVersions(
      array(entry.versions, `candidate index ${where} ${replacement[indexField]} versions`).map((item) => {
        object(item, `candidate index ${where} version`);
        return item.version;
      }),
      `candidate index ${where} ${replacement[indexField]} versions`,
    );
    if (versions.filter((version) => version === replacement.version).length !== 1) {
      fail(`candidate index is missing replacement ${where} ${replacement[indexField]}@${replacement.version}`);
    }
  }
  return replacements.length;
}

function verifyRevocations(index, proof) {
  const preserved = object(proof.preservedRevocations, "candidate proof preservedRevocations");
  const additions = candidateIdentities(proof.additionalPluginRevocations, "id", "candidate proof additionalPluginRevocations");
  const rejected = candidateIdentities(proof.preRevocationRejectedVersions, "id", "candidate proof preRevocationRejectedVersions");
  const actual = object(index.revoked, "candidate index revoked");
  onlyKeys(preserved, ["plugins", "sidecars", "core"], "candidate proof preservedRevocations");
  onlyKeys(actual, ["plugins", "sidecars", "core"], "candidate index revoked");
  for (const key of ["plugins", "sidecars"]) {
    array(preserved[key], `candidate proof preservedRevocations.${key}`);
    array(actual[key], `candidate index revoked.${key}`);
  }
  const preservedCore = Object.hasOwn(preserved, "core");
  const actualCore = Object.hasOwn(actual, "core");
  if (preservedCore) {
    array(preserved.core, "candidate proof preservedRevocations.core");
  }
  if (actualCore) array(actual.core, "candidate index revoked.core");
  if (!isDeepStrictEqual(rejected.map(({ id, version }) => `${id}@${version}`).sort(), additions.map(({ id, version }) => `${id}@${version}`).sort())) {
    fail("candidate proof pre-revocation failures differ from the additional plugin revocations");
  }
  for (const entry of rejected) {
    if (typeof entry.field !== "string" || entry.field === "") fail(`candidate proof pre-revocation failure ${entry.id}@${entry.version} has no field`);
  }
  const expected = {
    plugins: [...preserved.plugins, ...additions],
    sidecars: preserved.sidecars,
    core: preserved.core ?? [],
  };
  const projectedActual = { plugins: actual.plugins, sidecars: actual.sidecars, core: actual.core ?? [] };
  if (!isDeepStrictEqual(projectedActual, expected)) fail("candidate index revocation projection differs from the proof");
}

/** Verifies the exact raw bytes and the producer proof's SDK and projection claims. */
export function verifyCandidateRegistry(indexBytes, proofBytes, identity, expectedDigests = {}) {
  if (!Buffer.isBuffer(indexBytes) || !Buffer.isBuffer(proofBytes)) fail("candidate index and proof bytes are required");
  for (const [name, digest] of [["index", expectedDigests.indexSha256], ["proof", expectedDigests.proofSha256]]) {
    if (digest !== undefined && !HASH.test(digest)) fail(`--${name}-sha256 must be 64 lowercase hexadecimal characters`);
  }
  if (expectedDigests.indexSha256 !== undefined) {
    const actual = sha256(indexBytes);
    if (actual !== expectedDigests.indexSha256) fail(`index sha256 ${actual} differs from expected ${expectedDigests.indexSha256}`);
  }
  if (expectedDigests.proofSha256 !== undefined) {
    const actual = sha256(proofBytes);
    if (actual !== expectedDigests.proofSha256) fail(`proof sha256 ${actual} differs from expected ${expectedDigests.proofSha256}`);
  }

  const index = parseBytes(indexBytes, "index");
  const proof = parseBytes(proofBytes, "proof");
  object(index, "candidate index");
  object(proof, "candidate proof");
  if (index.format !== 1) fail(`candidate index format ${index.format} is unsupported`);
  if (proof.format !== 1) fail(`candidate proof format ${proof.format} is unsupported`);
  if (typeof proof.registrySourceRevision !== "string" || !REVISION.test(proof.registrySourceRevision)) {
    fail("candidate proof registrySourceRevision must be a full Git commit id");
  }
  if (typeof proof.indexSha256 !== "string" || !HASH.test(proof.indexSha256) || proof.indexSha256 !== sha256(indexBytes)) {
    fail("candidate proof indexSha256 does not match the candidate index bytes");
  }
  if (typeof proof.preservedCoreJsonSha256 !== "string" || !HASH.test(proof.preservedCoreJsonSha256)) {
    fail("candidate proof preservedCoreJsonSha256 must be a SHA-256 digest");
  }

  const sdk = object(proof.candidateSdk, "candidate proof candidateSdk");
  if (typeof sdk.sourceRevision !== "string" || !REVISION.test(sdk.sourceRevision)) {
    fail("candidate SDK sourceRevision must be a full Git commit id");
  }
  if (typeof sdk.apiTree !== "string" || !REVISION.test(sdk.apiTree)) {
    fail("candidate proof candidateSdk.apiTree must be a full Git tree id");
  }
  if (typeof identity?.coreVersion !== "string" || identity.coreVersion === "") {
    fail("current SDK identity requires a nonempty core version");
  }
  if (typeof identity.apiTree !== "string" || !REVISION.test(identity.apiTree)) {
    fail("current SDK identity requires a full API tree id");
  }
  if (typeof sdk.apiVersion !== "string" || sdk.apiVersion === "" ||
      typeof proof.candidateCoreVersion !== "string" || proof.candidateCoreVersion === "") {
    fail("candidate SDK versions must be nonempty strings");
  }
  if (sdk.apiVersion !== identity.coreVersion || proof.candidateCoreVersion !== identity.coreVersion) {
    fail(`candidate SDK version ${sdk.apiVersion}/${proof.candidateCoreVersion} differs from current SDK ${identity.coreVersion}`);
  }
  if (sdk.apiTree !== identity.apiTree) fail(`candidate SDK API tree ${sdk.apiTree} differs from current HEAD tree ${identity.apiTree}`);

  const coreVersions = uniqueVersions(
    array(object(index.core, "candidate index core").versions, "candidate index core versions").map((entry) => {
      object(entry, "candidate index core version");
      return entry.version;
    }),
    "candidate index core versions",
  );
  const preservedCoreVersions = uniqueVersions(proof.preservedCoreVersions, "candidate proof preservedCoreVersions");
  if (preservedCoreVersions.length === 0) fail("candidate proof preservedCoreVersions must not be empty");
  if (!isDeepStrictEqual([...coreVersions].sort(), [...preservedCoreVersions].sort())) fail("candidate index core version projection differs from the proof");
  if (coreVersions.includes(proof.candidateCoreVersion)) fail(`candidate index includes core ${proof.candidateCoreVersion} before its release files exist`);

  const pluginCount = verifyReplacementProjection(index, proof, "replacementPlugins", "id", "plugin", true);
  const sidecarCount = verifyReplacementProjection(index, proof, "replacementSidecars", "name", "sidecar");
  if (!Number.isSafeInteger(proof.candidateManifestChecked) || proof.candidateManifestChecked !== pluginCount) {
    fail("candidate proof candidateManifestChecked must equal the nonempty replacement plugin projection");
  }
  verifyRevocations(index, proof);
  return {
    coreVersion: identity.coreVersion,
    plugins: pluginCount,
    sidecars: sidecarCount,
    producerReportedManifestCount: proof.candidateManifestChecked,
  };
}

async function fetchBytes(url, label) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    fail(`${label} URL is invalid: ${error.message}`);
  }
  const start = performance.now();
  console.log(`${label} download started: ${url}`);
  try {
    let bytes;
    if (parsed.protocol === "file:") {
      bytes = readFileSync(fileURLToPath(parsed));
    } else if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      const response = await fetch(parsed, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) fail(`${label} ${url}: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
    } else {
      fail(`${label} URL protocol ${parsed.protocol} is unsupported`);
    }
    console.log(`${label} download finished: ${bytes.length} bytes in ${(performance.now() - start).toFixed(1)} ms`);
    return bytes;
  } catch (error) {
    console.error(`${label} download failed after ${(performance.now() - start).toFixed(1)} ms: ${error.message}`);
    throw error;
  }
}

export function readCurrentIdentity(root = ROOT) {
  const packageJson = JSON.parse(readFileSync(join(root, "packages/plugin-api/package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || packageJson.version === "") {
    fail("current SDK package version must be a nonempty string");
  }
  const changes = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all", "--", "packages/plugin-api"], { encoding: "utf8" }).trim();
  if (changes !== "") fail(`SDK package has uncommitted source changes: ${changes.replaceAll("\n", ", ")}`);
  const apiTree = execFileSync("git", ["-C", root, "rev-parse", "HEAD:packages/plugin-api"], { encoding: "utf8" }).trim();
  return { coreVersion: packageJson.version, apiTree };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        index: { type: "string" },
        "index-sha256": { type: "string" },
        proof: { type: "string" },
        "proof-sha256": { type: "string" },
      },
      strict: true,
    });
    if (!values.index || !values["index-sha256"] || !values.proof || !values["proof-sha256"]) {
      fail("usage: node scripts/check-candidate-registry.mjs --index URL --index-sha256 HASH --proof URL --proof-sha256 HASH");
    }
    for (const [label, value] of [["index", values.index], ["proof", values.proof]]) {
      if (value === "") fail(`--${label} must be a nonempty URL`);
    }
    if (!HASH.test(values["index-sha256"])) fail("--index-sha256 must be 64 lowercase hexadecimal characters");
    if (!HASH.test(values["proof-sha256"])) fail("--proof-sha256 must be 64 lowercase hexadecimal characters");
    const indexBytes = await fetchBytes(values.index, "candidate index");
    const proofBytes = await fetchBytes(values.proof, "candidate proof");
    const result = verifyCandidateRegistry(indexBytes, proofBytes, readCurrentIdentity(), {
      indexSha256: values["index-sha256"],
      proofSha256: values["proof-sha256"],
    });
    console.log(`Candidate registry proof check passed: core ${result.coreVersion}, ${result.plugins} plugin replacements, ${result.sidecars} sidecar replacements, producer-reported manifest count ${result.producerReportedManifestCount}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
