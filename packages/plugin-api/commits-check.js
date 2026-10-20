#!/usr/bin/env node
// Checks that a commit message has the form `type(scope): Subject (#ID)`, a blank line, a non-empty body and no footer. When the argument is a file, it checks that
// message (commit-msg hook); otherwise it checks each commit of the git ranges given as arguments.
//
//   soksak-commits <message file | revision range...>
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { commitMessageErrors } from "./records-check.js";

/** [name, message] for each message of targets. A single file is that one message; ranges give each commit that is not a merge. */
export function commitMessages(targets) {
  const [target] = targets;
  if (targets.length === 1 && existsSync(target)) return [["message", readFileSync(target, "utf8").replace(/^#.*\n?/gm, "")]];
  return execFileSync("git", ["rev-list", "--no-merges", ...targets], { encoding: "utf8" }).split("\n").filter(Boolean)
    .map((commit) => [commit.slice(0, 12), execFileSync("git", ["log", "-1", "--format=%B", commit], { encoding: "utf8" })]);
}

// A package manager places a package as a link, so the started path is resolved before it is compared with this module.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const targets = process.argv.slice(2);
  if (!targets.length) {
    process.stderr.write("usage: soksak-commits <message file | revision range...>\n");
    process.exit(2);
  }
  const messages = commitMessages(targets);
  const errors = messages.flatMap(([name, message]) => commitMessageErrors(message).map((error) => `${name}: ${error}`));
  if (errors.length) {
    process.stderr.write(errors.map((error) => `${error}\n`).join(""));
    process.exit(1);
  }
  process.stdout.write(`Commit message checks passed: ${messages.length} messages\n`);
}
