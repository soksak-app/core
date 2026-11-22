import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The rule of web pages (docs/spec/cli.md#agent-skill), worded the same in every text that an agent reads: the skill that
// `sok skill print` writes, the instructions of `sok mcp` and the usage of both sok implementations.
const RULE = "When a plugin of the window opens web addresses, such as browser, every web page that you open, test, play or check, "
  + "a local server too, goes into a tab of that plugin first: open it with core.layout.open {card, plugin, params?}, go to the "
  + "address with its navigate command, such as browser.navigate {url}, and read and act through its declared commands, statuses "
  + "and elements. Use an outside browser, a headless browser or a browser automation library only when no such plugin is installed "
  + "or the person asks for one, and state which case applies.";

const flat = (text) => text.replace(/\s+/g, " ");

const SOURCES = {
  "the agent skill": () => readFileSync(join(ROOT, "packages/sok/go/src/agents/SKILL.md"), "utf8"),
  "the MCP instructions": () => JSON.parse(readFileSync(join(ROOT, "packages/sok/go/src/agents/mcp.json"), "utf8")).instructions,
  "the usage of the Go sok": () => readFileSync(join(ROOT, "packages/sok/go/src/sok.go"), "utf8"),
  "the usage of the Rust sok": () => readFileSync(join(ROOT, "packages/sok/rust/src/sok.rs"), "utf8"),
};

const holds = (name) => assert.ok(flat(SOURCES[name]()).includes(RULE), `${name} lacks the rule of web pages: ${RULE}`);

test("the agent skill states the rule of web pages: a plugin of the window first, an outside browser only without one", () => holds("the agent skill"));
test("the MCP instructions states the rule of web pages: a plugin of the window first, an outside browser only without one", () => holds("the MCP instructions"));
test("the usage of the Go sok states the rule of web pages: a plugin of the window first, an outside browser only without one", () => holds("the usage of the Go sok"));
test("the usage of the Rust sok states the rule of web pages: a plugin of the window first, an outside browser only without one", () => holds("the usage of the Rust sok"));

test("the agent skill states the rule of web pages in its section Acting on a layout", () => {
  const text = SOURCES["the agent skill"]();
  const start = text.indexOf("## Acting on a layout");
  assert.ok(start !== -1, "the agent skill has no section Acting on a layout");
  const end = text.indexOf("\n## ", start + 1);
  assert.ok(flat(text.slice(start, end === -1 ? text.length : end)).includes(RULE), "the section Acting on a layout lacks the rule");
});
