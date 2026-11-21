import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const read = (file) => readFileSync(join(ROOT, file), "utf8");
const normalize = (text) => text.replace(/\s+/g, " ");

// The sections of the agent skill by their level-2 heading, in their order.
function sections(text) {
  const parts = text.split(/^## /m).slice(1);
  return parts.map((part) => {
    const end = part.indexOf("\n");
    return { heading: part.slice(0, end).trim(), body: normalize(part.slice(end + 1)) };
  });
}

// The phrases that the guidance of group cards states (docs/spec/groups.md#commands): the command that makes a group, that it
// nests a group when it is run on a card of a group, the two ways to add a card to the plane of a group, that the neighbour of an open
// is a card of the plane (docs/spec/groups.md#card-commands-on-a-group-card), the dissolve and the move.
const PHRASES = [
  "`core.group.create {card, side, plugin, params?}`",
  "nests a new group",
  "once per group",
  "`core.layout.open {card: <a card of the group>, side, plugin}`",
  "`core.card.add-tab {card: <group>, plugin}`",
  "looks for the neighbour toward `side` only among the cards of that plane",
  "lists every group card once",
  "read `layout` again right before each step",
  "`core.group.dissolve {group}`",
  "`core.card.move {card, target, side}`",
  "A split never creates a group",
];

test("the agent skill describes group cards after acting on a layout", () => {
  const list = sections(read("packages/sok/go/src/agents/SKILL.md"));
  const headings = list.map((section) => section.heading);
  const groups = headings.indexOf("Groups");
  assert.ok(groups !== -1, `the agent skill has no section Groups; its sections are ${headings.join(", ")}`);
  // The section of the agent role stands between them (docs/spec/agent-roles.md), so the section Groups follows the section of
  // the agent role, which follows the section Acting on a layout.
  assert.equal(headings[groups - 1], "Opening a tab with an agent role", "the section Groups follows the section Opening a tab with an agent role");
  assert.equal(headings[groups - 2], "Acting on a layout", "the agent role section follows the section Acting on a layout");
  const missing = PHRASES.filter((phrase) => !list[groups].body.includes(phrase));
  assert.deepEqual(missing, [], "the section Groups does not state these phrases");
});

test("the MCP instructions name the command that makes a group and its nesting", () => {
  const { instructions } = JSON.parse(read("packages/sok/go/src/agents/mcp.json"));
  const missing = ["core.group.create", "nests a new group", "once per group"].filter((phrase) => !instructions.includes(phrase));
  assert.deepEqual(missing, [], "the MCP instructions do not state these phrases");
});
