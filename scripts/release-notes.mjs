// Writes the release body from a document of this repository: the release page resolves a relative link against the root of
// the tag, so each relative link becomes the address of its file at the tag (docs/operations/examples.md#release).
import { readFileSync } from "node:fs";

import { absolute, markdownLinks } from "./markdown-links.mjs";

/** text with each relative link resolved against file, a path of the repository, to its address at tag. */
export function releaseNotes(text, { file, repository, tag }) {
  const base = new URL(file, `https://github.com/${repository}/blob/${tag}/`);
  let result = "";
  let at = 0;
  for (const link of markdownLinks(text)) {
    if (absolute(link.target)) continue;
    result += text.slice(at, link.start) + new URL(link.target, base).href;
    at = link.end;
  }
  return result + text.slice(at);
}

if (import.meta.main) {
  const [file, repository, tag] = process.argv.slice(2);
  if (!file || !repository || !tag) throw new Error("usage: release-notes.mjs <document> <owner/repository> <tag>");
  process.stdout.write(releaseNotes(readFileSync(file, "utf8"), { file, repository, tag }));
}
