// An arrow key on a divider runs core.boundary.move with the position one step away, and the centring by Enter or by a double click
// runs core.boundary.center, so each is one workbench.layout.change (docs/spec/groups.md#commands).
import assert from "node:assert/strict";
import test from "node:test";
import { openLayoutChangePage } from "./support/layout-change-page.mjs";

const { wire: keys, registry, plane, flushEvents } = await openLayoutChangePage("layout-change-keys");

test("an arrow key, Enter and a double click on a divider are each one workbench.layout.change of their command", { timeout: 10000 }, async () => {
  const grid = plane.currentGrid();
  const divider = () => document.querySelector('.sp-divider[data-axis="x"]');
  const line = Number(divider().dataset.line);
  const key = (name) => divider().dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true }));
  const press = (type) => (type === "mousedown" ? divider() : document)
    .dispatchEvent(new window.MouseEvent(type, { clientX: grid.boundaryPos("x", line), clientY: 100, button: 0, buttons: type === "mousedown" ? 1 : 0, bubbles: true }));
  const from = grid.boundaryPos("x", line);
  key("ArrowRight");
  await registry.commandsEnded();
  assert.equal(grid.boundaryPos("x", line), from + 8, "the arrow key moves the line one step");
  key("Enter");
  await registry.commandsEnded();
  key("ArrowRight");
  await registry.commandsEnded();
  for (const type of ["mousedown", "mouseup", "mousedown", "mouseup"]) press(type);
  await registry.commandsEnded();
  await flushEvents();
  const events = keys.calls.filter(({ name, payload }) => name === "log" && payload?.action === "batch").flatMap(({ payload }) => payload.events)
    .filter(({ event }) => event === "workbench.layout.change");
  assert.deepEqual(events.map(({ fields }) => [fields.command, Object.keys(JSON.parse(fields.params))]), [
    ["core.boundary.move", ["axis", "line", "position"]],
    ["core.boundary.center", ["axis", "line"]],
    ["core.boundary.move", ["axis", "line", "position"]],
    ["core.boundary.center", ["axis", "line"]],
  ]);
  assert.deepEqual(JSON.parse(events[0].fields.params), { axis: "x", line, position: from + 8 });
  keys.finish();
});
