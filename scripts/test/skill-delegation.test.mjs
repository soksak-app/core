import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const flat = (text) => text.replace(/\s+/g, " ");

// The rule by purpose (docs/spec/cli.md#agent-skill, docs/spec/messaging.md#report-request): a submit command imitates the input of a
// person, and agents talk through messages, whose answer arrives as injected input, and poll nothing for a result.
const RULE = "A submit command imitates the input of a person: use it to type a line that a person would type into a program, such as a shell command or the answer to a program's question. Agents talk through messages: to give another agent a task, ask it something or report to it, send a message with `sok message send` to the folder of its terminal. The message carries the report request, and the answer arrives as your own injected input, so end your turn and wait at the prompt. Never poll files or statuses for a result.";

test("the agent skill and the MCP instructions state the purpose of a submit command and that agents talk through messages", { timeout: 5000 }, () => {
  const mcp = JSON.parse(readFileSync(join(ROOT, "packages/sok/go/src/agents/mcp.json"), "utf8"));
  const places = {
    "the agent skill": flat(readFileSync(join(ROOT, "packages/sok/go/src/agents/SKILL.md"), "utf8")),
    "the MCP instructions": flat(mcp.instructions),
  };
  const missing = Object.entries(places).filter(([, text]) => !text.includes(RULE)).map(([place]) => place);
  assert.deepEqual(missing, [], `the rule by purpose is missing from ${missing.join(", ")}`);
});
