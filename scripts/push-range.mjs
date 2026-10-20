#!/usr/bin/env node
// Prints the commit ranges that a push sends, separated by spaces, from the ref lines that git gives a pre-push hook on stdin
// (`<local ref> <local sha> <remote ref> <remote sha>`). The range of a pushed ref is the commits of its local sha that the remote ref
// does not have. A new remote ref has the zero sha as its remote sha, so its range starts at <remote>/main. A deleted local ref has the
// zero sha as its local sha and sends no commits.
//
//   node scripts/push-range.mjs <remote name> < ref lines
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ZERO_SHA = /^0+$/;

/** The ranges of the ref lines of input, for a push to remote. Each line of input is one pushed ref. */
export function pushRanges(input, remote) {
  return input.split("\n").filter(Boolean).flatMap((line) => {
    const fields = line.split(" ");
    if (fields.length !== 4) throw new Error(`invalid pre-push ref line: ${line}`);
    const [, localSha, , remoteSha] = fields;
    if (ZERO_SHA.test(localSha)) return [];
    return [ZERO_SHA.test(remoteSha) ? `${remote}/main..${localSha}` : `${remoteSha}..${localSha}`];
  });
}

// A package manager places a package as a link, so the started path is resolved before it is compared with this module.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [remote] = process.argv.slice(2);
  if (!remote) {
    process.stderr.write("usage: push-range.mjs <remote name> < ref lines\n");
    process.exit(2);
  }
  process.stdout.write(`${pushRanges(readFileSync(0, "utf8"), remote).join(" ")}\n`);
}
