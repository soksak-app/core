import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// The rule of web pages (docs/spec/cli.md#agent-skill): an agent shows a web page or an address in a tab of a plugin of the
// window that opens it, and uses a browser outside the application only when no plugin of the window opens it or the person asks.
const PHRASES = [
  "A web page or an address is shown in a tab",
  "`core.layout.open`",
  "a browser outside the application only when no plugin of the window opens it or the person asks for one",
];

test("the agent skill shows a web page in a plugin of the window before a browser outside the application", () => {
  const text = readFileSync(join(ROOT, "packages/sok/go/src/agents/SKILL.md"), "utf8");
  const start = text.indexOf("## Acting on a layout");
  assert.ok(start !== -1, "the agent skill has no section Acting on a layout");
  const end = text.indexOf("\n## ", start + 1);
  const section = text.slice(start, end === -1 ? text.length : end).replace(/\s+/g, " ");
  const missing = PHRASES.filter((phrase) => !section.includes(phrase));
  assert.deepEqual(missing, [], `the section Acting on a layout lacks ${JSON.stringify(missing)}`);
});
