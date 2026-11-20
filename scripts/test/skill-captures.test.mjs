import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The observation of a window (docs/spec/cli.md#agent-skill, docs/spec/endpoint.md): a still capture needs no activation, an occluded
// window draws no image region and opens no terminal session, draw-covered makes a covered window draw, and the diagnostic methods
// exist only in diagnostic builds, which every 0.0.x release is (docs/spec/endpoint.md).
const PHRASES = [
  "A still capture (`diagnostics.capture.still`, `sok capture`) shows what the window draws and needs no activation.",
  "A fully occluded window draws no image region and its terminals open no session, so read `occluded` in `host.window` before judging an empty view.",
  "To observe a covered window, turn on `diagnostics.window.draw-covered {window, draw: true}` and turn it off afterwards.",
  "These diagnostic methods exist only in diagnostic builds, which every 0.0.x release is; a release of a later version series rejects them.",
];

test("the agent skill states how to observe a window that is covered, and that the methods exist only in diagnostic builds", { timeout: 5000 }, () => {
  const text = readFileSync(join(ROOT, "packages/sok/go/src/agents/SKILL.md"), "utf8");
  const start = text.indexOf("## Running and observing");
  assert.ok(start !== -1, "the agent skill has no section Running and observing");
  const end = text.indexOf("\n## ", start + 1);
  const section = text.slice(start, end === -1 ? text.length : end).replace(/\s+/g, " ");
  const missing = PHRASES.filter((phrase) => !section.includes(phrase));
  assert.deepEqual(missing, [], `the section Running and observing lacks ${JSON.stringify(missing)}`);
});
