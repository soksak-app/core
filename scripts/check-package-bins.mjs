#!/usr/bin/env node
// Every file that a workspace package.json declares in `bin` is tracked as executable (mode 100755) and starts with
// a `#!` line. pnpm sets the executable bit on each bin target when it installs, so a bin target tracked as 100644
// leaves the working tree modified after every install.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

/** The bin targets of one package.json text, as repository paths. */
export function binTargets(manifestPath, text) {
  const manifest = JSON.parse(text);
  if (manifest.bin === undefined) return [];
  const bins = typeof manifest.bin === "string" ? { [manifest.name]: manifest.bin } : manifest.bin;
  return Object.values(bins).map((target) => posix.normalize(posix.join(posix.dirname(manifestPath), target)));
}

/**
 * Audits bin targets. `entries` holds {path, mode, head}: mode is the tracked git mode and head is the first line of
 * the file. Returns one error per target that is not tracked as 100755 or does not start with `#!`.
 */
export function auditBins(entries) {
  const errors = [];
  for (const { path, mode, head } of entries) {
    if (mode !== "100755") errors.push(`${path}: a package bin target is tracked with mode ${mode}, not 100755`);
    if (!head.startsWith("#!")) errors.push(`${path}: a package bin target does not start with a #! line`);
  }
  return errors;
}

/** The bin target entries of the tracked workspace package.json files under `root`. */
export function repositoryBins(root) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const manifests = git("ls-files", "package.json", "**/package.json").split("\n").filter(Boolean);
  const entries = [];
  for (const manifest of manifests) {
    for (const path of binTargets(manifest, readFileSync(join(root, manifest), "utf8"))) {
      const staged = git("ls-files", "-s", "--", path).trim();
      if (staged === "") throw new Error(`${manifest}: bin target ${path} is not tracked`);
      entries.push({ path, mode: staged.split(" ")[0], head: readFileSync(join(root, path), "utf8").split("\n")[0] });
    }
  }
  return entries;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const errors = auditBins(repositoryBins(root));
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log("Package bin checks passed");
}
