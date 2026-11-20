// Every command that changes the stored layout of the active space, one that answers at once and one that answers later, is the
// event workbench.layout.change with its name, its parameters, its answer and the stored layout that it left; a command that leaves
// the layout as it was and a command that fails write none (docs/spec/events.json).
import assert from "node:assert/strict";
import test from "node:test";
import { PLAIN, openLayoutChangePage } from "./support/layout-change-page.mjs";
import { stateCards } from "../layout-tree.js";

const { wire, registry, plane, flushEvents } = await openLayoutChangePage("layout-change-commands");

// A command that answers in a later step: it waits for a task of the event loop and then renames the group.
registry.declare("core", { status: [], element: [], commands: [{ name: "core.fixture.rename-later", description: "Renames the group later.",
  params: { type: "object", properties: { name: { type: "string" } } }, result: { type: "null" } }] });
registry.command("core.fixture.rename-later", async ({ name }) => {
  await new Promise((resolve) => setImmediate(resolve));
  plane.renameGroup("card-3", name);
  return null;
});

test("a command that changes the layout is the event workbench.layout.change with the layout that it left", { timeout: 10000 }, async () => {
  const split = await registry.run("core.card.split", { card: "card-2", side: "bottom", plugin: PLAIN });
  await registry.run("core.card.focus", { card: "card-1" });
  await assert.rejects(registry.run("core.group.rename", { group: "card-1", name: "x" }));
  await registry.run("core.group.rename", { group: "card-3", name: "그룹 2" });
  await registry.run("core.fixture.rename-later", { name: "그룹 3" });
  await flushEvents();
  const events = wire.calls.filter(({ name, payload }) => name === "log" && payload?.action === "batch").flatMap(({ payload }) => payload.events)
    .filter(({ event }) => event === "workbench.layout.change");
  assert.deepEqual(events.map(({ level, fields }) => [level, fields.command, fields.params, fields.paramsTruncated, fields.layoutTruncated]), [
    ["debug", "core.card.split", '{"card":"card-2","side":"bottom","plugin":"fixture-plain"}', false, false],
    ["debug", "core.group.rename", '{"group":"card-3","name":"그룹 2"}', false, false],
    ["debug", "core.fixture.rename-later", '{"name":"그룹 3"}', false, false],
  ]);
  assert.equal(events[0].fields.result, JSON.stringify(split));
  assert.equal(events[1].fields.result, '{"group":"card-3","name":"그룹 2"}');
  assert.equal(events[2].fields.result, "null");
  const layouts = events.map(({ fields }) => JSON.parse(fields.layout));
  assert.deepEqual(layouts.map((layout) => Object.keys(layout)), [["state", "leader", "lastCard"], ["state", "leader", "lastCard"],
    ["state", "leader", "lastCard"]]);
  assert.deepEqual(stateCards(layouts[0].state).map((card) => card.id), ["card-1", "card-2", split.card]);
  assert.deepEqual(layouts.map((layout) => layout.state.root.data.name), ["그룹 1", "그룹 2", "그룹 3"]);
  assert.equal(layouts[0].lastCard, 4);
  wire.finish();
});
