import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");

// The guidance of a report (docs/spec/messaging.md#report-request): sok message send adds the request for a report, so an agent writes
// none, and a report goes with --reply, which adds none, so a report is never answered. The sentence holds no backtick, because the Go
// usage is a raw string literal.
const REPORT = "sok message send FOLDER TEXT adds to TEXT the request to report the result with sok message send --reply to the folder of the sender, so a sender writes no request; a report is sent with --reply, which adds none, and a report is never answered.";
// The guidance of receiving (docs/spec/messaging.md#injected-message): an agent in a soksak terminal receives each message as injected
// input, so a wait on messages_wait would deliver it twice and keep the agent in a tool call.
const RECEIVE = "An agent in a soksak terminal receives each message as injected input and does not loop on `messages_wait`; `messages_read` and `messages_wait` are for an agent outside a soksak terminal or for reading the history.";

const mcp = JSON.parse(readFileSync(join(ROOT, "packages/sok/go/src/agents/mcp.json"), "utf8"));
const tool = (name) => mcp.tools.find((entry) => entry.name === name).description.replace(/\s+/g, " ");

test("the report guidance sentence is in the agent skill, the MCP instructions, both sok usage texts and the command reference", { timeout: 5000 }, () => {
  const places = {
    "the agent skill": read("packages/sok/go/src/agents/SKILL.md"),
    "the MCP instructions": mcp.instructions.replace(/\s+/g, " "),
    "the Go usage": read("packages/sok/go/src/sok.go"),
    "the Rust usage": read("packages/sok/rust/src/sok.rs"),
    "the command reference": read("docs/spec/cli.md"),
  };
  const missing = Object.entries(places).filter(([, text]) => !text.includes(REPORT)).map(([place]) => place);
  assert.deepEqual(missing, [], `the report guidance is missing from ${missing.join(", ")}`);
});

test("the receive guidance sentence is in the agent skill, the MCP instructions and the descriptions of messages_read and messages_wait", { timeout: 5000 }, () => {
  const places = {
    "the agent skill": read("packages/sok/go/src/agents/SKILL.md"),
    "the MCP instructions": mcp.instructions.replace(/\s+/g, " "),
    "messages_read": tool("messages_read"),
    "messages_wait": tool("messages_wait"),
  };
  const missing = Object.entries(places).filter(([, text]) => !text.includes(RECEIVE)).map(([place]) => place);
  assert.deepEqual(missing, [], `the receive guidance is missing from ${missing.join(", ")}`);
});

test("the descriptions of messages_read and messages_wait state that a received message carries the report request and how to answer it", { timeout: 5000 }, () => {
  const ANSWER = "A received message ends with the request to report with `sok message send --reply`; answer it once with that command, and answer no report.";
  const missing = ["messages_read", "messages_wait"].filter((name) => !tool(name).includes(ANSWER));
  assert.deepEqual(missing, [], `the answer guidance is missing from ${missing.join(", ")}`);
});
