import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const flat = (text) => text.replace(/\s+/g, " ");

// The rule of delegation (docs/spec/cli.md#agent-skill, docs/spec/messaging.md#report-request): an agent gives a task to another agent
// with a message, whose report arrives as injected input, and does not poll for a result or delegate with a submit command.
const RULE = "To give another agent a task and get its result, send a message with `sok message send` to the folder of its terminal: the message carries the report request, and the report arrives as your own injected input, so end your turn and wait at the prompt. Never poll files or statuses for a result. A submit command types a line as a person would; it is not for delegating.";

test("the agent skill and the MCP instructions state the rule of delegation through messages", { timeout: 5000 }, () => {
  const mcp = JSON.parse(readFileSync(join(ROOT, "packages/sok/go/src/agents/mcp.json"), "utf8"));
  const places = {
    "the agent skill": flat(readFileSync(join(ROOT, "packages/sok/go/src/agents/SKILL.md"), "utf8")),
    "the MCP instructions": flat(mcp.instructions),
  };
  const missing = Object.entries(places).filter(([, text]) => !text.includes(RULE)).map(([place]) => place);
  assert.deepEqual(missing, [], `the rule of delegation is missing from ${missing.join(", ")}`);
});
