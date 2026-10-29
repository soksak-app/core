#!/usr/bin/env node
// Decides whether a repository releases the version that its package.json declares. The repository releases when the
// remote has no tag of that version and its checklist has no open item: every item in the state `[ ]`, `[~]` or `[!]`
// holds the release, because none of them is complete. The decision reads only the files and the remote tags of the
// repository, so no other repository takes part in it.
//
//   soksak-release-gate <package.json> <checklist>
//
// It prints the decision and, when GITHUB_OUTPUT names a file, writes `release` (`true` or `false`) and `version` to it.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { checklist } from "./checklist.js";

const OPEN = new Set([" ", "~", "!"]);

/** The declared version of the manifest text, or an error that names the file and what it found. */
export function declaredVersion(name, text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`${name}: not JSON: ${error.message}`);
  }
  const { version } = manifest;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${name}: version must be a string of the form <major>.<minor>.<patch>, found ${JSON.stringify(version)}`);
  }
  return version;
}

/** The items of the checklist text that hold a release, as `<id> [<state>]`. An open item without an identifier is an error. */
export function holdingItems(name, text) {
  const errors = [];
  const open = checklist(text, name, errors).filter(({ state }) => OPEN.has(state));
  const unnamed = open.filter(({ id }) => !id).length;
  if (unnamed) errors.push(`${name}: ${unnamed} open checklist items have no identifier`);
  if (errors.length) throw new Error(errors.join("\n"));
  return open.map(({ id, state }) => `${id} [${state}]`);
}

/** The decision for the manifest and checklist texts and whether the remote has the tag: { release, version, reasons }. */
export function releaseDecision({ manifestName, manifestText, checklistName, checklistText, tagExists }) {
  const version = declaredVersion(manifestName, manifestText);
  const reasons = [];
  if (tagExists(`v${version}`)) reasons.push(`the tag v${version} exists`);
  const holding = holdingItems(checklistName, checklistText);
  if (holding.length) reasons.push(`${holding.length} open items: ${holding.join(", ")}`);
  return { release: reasons.length === 0, version, reasons };
}

/** Whether the remote origin has the tag. A failure of git is an error, so an unknown tag set never reads as empty. */
export function remoteTagExists(tag) {
  return execFileSync("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { encoding: "utf8" }).trim() !== "";
}

// A package manager places a package as a link, so the started path is resolved before it is compared with this module.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [manifestName, checklistName, ...rest] = process.argv.slice(2);
  if (!manifestName || !checklistName || rest.length) {
    process.stderr.write("usage: soksak-release-gate <package.json> <checklist>\n");
    process.exit(2);
  }
  let decision;
  try {
    decision = releaseDecision({
      manifestName, manifestText: readFileSync(manifestName, "utf8"),
      checklistName, checklistText: readFileSync(checklistName, "utf8"), tagExists: remoteTagExists,
    });
  } catch (error) {
    process.stderr.write(`release gate: ${error.message}\n`);
    process.exit(1);
  }
  const { release, version, reasons } = decision;
  process.stdout.write(release ? `release v${version}\n` : `no release of v${version}: ${reasons.join("; ")}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `release=${release}\nversion=${version}\n`);
}
