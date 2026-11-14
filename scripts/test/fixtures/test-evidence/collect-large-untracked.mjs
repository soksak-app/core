// Collects the evidence of the untracked file large.log of the repository that argument 2 names, and writes its resident memory before
// the collection, its peak resident memory after it and the digest of the file as one JSON line on standard output.
import { collectEvidence } from "../../../test-evidence.mjs";

const before = process.memoryUsage.rss();
const record = await collectEvidence({
  root: process.argv[2], caseId: "large-untracked-file", language: "js-ts",
  implementationFiles: ["source.mjs"], testFiles: ["source.mjs"], dependencyFiles: ["source.mjs"], buildFlags: [],
  result: { status: "pass", expected: 1, actual: 1, elapsedMs: 1 },
});
const file = record.git.files.find(({ path }) => path === "large.log");
process.stdout.write(`${JSON.stringify({ before, peak: process.resourceUsage().maxRSS * 1024, sha256: file?.sha256 })}\n`);
