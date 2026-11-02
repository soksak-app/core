import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

// A record states facts about this repository; it does not cite another application as a precedent, a reference or a
// comparison (AGENTS.md, Documentation). The patterns are the citations that earlier records made; a factual dependency,
// such as the user agent that a document region sends or the browser that the browser example check drives, is not a
// citation and is not listed.
const CITATIONS = [/\bChromium\b/, /\bGhostty\b/, /\bWezTerm\b/, /\[kitty\]\(/, /\bdark in Chrome\b/, /Chrome에서는/];
const RECORDS = /^(docs\/.*\.md|CHANGELOG(\.ko)?\.md)$/;

test("records cite no other application as a precedent or a reference", { timeout: 10000 }, () => {
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter((file) => RECORDS.test(file));
  const found = [];
  for (const file of files) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      for (const citation of CITATIONS) if (citation.test(line)) found.push(`${file}:${index + 1}: ${citation}`);
    });
  }
  assert.deepEqual(found, []);
});
