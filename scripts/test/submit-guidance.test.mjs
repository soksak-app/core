import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SENTENCE = "A declared submit command sends its text as one paste, which the sidecar brackets when the program enabled bracketed paste mode, and Enter as a separate input after the reply of the paste, refuses text that contains CR or LF, and returns only that the sidecar answered both inputs; confirm acceptance from the status of the input line and of the agent busy state, never by waiting with a timer.";

// The places that hold the guidance: the usage text of the Go sok, the usage text of the Rust sok, the agent skill that both
// implementations embed and the command reference.
const TEXTS = {
  "packages/sok/go/src/sok.go": "sok help (Go)",
  "packages/sok/rust/src/sok.rs": "sok help (Rust)",
  "packages/sok/go/src/agents/SKILL.md": "agent skill",
  "docs/spec/cli.md": "command reference",
};

const normalize = (text) => text.replace(/\s+/g, " ");

test("the submit guidance sentence is identical in both sok usage texts, the agent skill and the command reference", () => {
  const missing = Object.entries(TEXTS)
    .filter(([file]) => !normalize(readFileSync(join(ROOT, file), "utf8")).includes(normalize(SENTENCE)))
    .map(([file, label]) => `${label} (${file})`);
  assert.deepEqual(missing, [], "these texts do not contain the submit guidance sentence");
});
