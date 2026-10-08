#!/usr/bin/env node
// Checks before a core release that every plugin version of the public registry that the new core installs still has a
// manifest that the new core accepts (docs/spec/installation.md#version-selection). A plugin version is checked when it
// is not revoked and its engines.soksak contains the core version; the check downloads its release, verifies the sha256,
// reads plugin.json and runs validateManifest of this checkout's @soksak/plugin-api.
//
//   node scripts/check-registry-manifests.mjs [--index URL]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rangeContains, validateManifest } from "../packages/plugin-api/index.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The bytes at url: an https or file URL. */
async function fetchBytes(url) {
  if (url.startsWith("file:")) return readFileSync(fileURLToPath(url));
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** plugin.json of a plugin release, a gzip tar with plugin.json at its root. */
function releaseManifest(bytes) {
  const folder = mkdtempSync(join(tmpdir(), "soksak-registry-manifest-"));
  try {
    const release = join(folder, "plugin.tgz");
    writeFileSync(release, bytes);
    return JSON.parse(execFileSync("tar", ["-xzOf", release, "plugin.json"], { encoding: "utf8" }));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** The errors of the plugin versions of index that core installs and whose manifests validateManifest rejects. */
export async function registryManifestErrors(index, core, fetchRelease = fetchBytes) {
  const revoked = new Set(index.revoked.plugins.map((entry) => `${entry.id}@${entry.version}`));
  const errors = [];
  let checked = 0;
  for (const plugin of index.plugins) {
    for (const version of plugin.versions) {
      if (revoked.has(`${plugin.id}@${version.version}`) || !rangeContains(version.engines.soksak, core)) continue;
      checked += 1;
      const where = `plugin ${plugin.id} ${version.version}`;
      try {
        const bytes = await fetchRelease(version.release.url);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest !== version.release.sha256) throw new Error(`release sha256 ${digest} differs from the index ${version.release.sha256}`);
        validateManifest(releaseManifest(bytes));
      } catch (error) {
        errors.push(`${where}: ${error.message}`);
      }
    }
  }
  return { checked, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--index");
  const environment = JSON.parse(readFileSync(join(ROOT, "apps/wailsv3/environment.json"), "utf8"));
  const url = at > 0 ? process.argv[at + 1] : environment.registry;
  if (typeof url !== "string" || url === "") {
    console.error("usage: node scripts/check-registry-manifests.mjs [--index URL]");
    process.exit(2);
  }
  const core = JSON.parse(readFileSync(join(ROOT, "packages/plugin-api/package.json"), "utf8")).version;
  const index = JSON.parse((await fetchBytes(url)).toString("utf8"));
  const { checked, errors } = await registryManifestErrors(index, core);
  if (errors.length) {
    console.error(errors.join("\n"));
    console.error(`${errors.length} of ${checked} plugin versions that core ${core} installs have manifests that it rejects; revoke them before the release`);
    process.exit(1);
  }
  console.log(`Registry manifest check passed: core ${core} accepts the manifests of ${checked} plugin versions of ${url}`);
}
