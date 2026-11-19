// A divider drag stores its result through the command core.boundary.move, so the drag is one workbench.layout.change
// (docs/spec/groups.md#commands).
import assert from "node:assert/strict";
import test from "node:test";
import { openLayoutChangePage } from "./support/layout-change-page.mjs";

const { wire: drag, registry, plane, flushEvents } = await openLayoutChangePage("layout-change-drag");

test("a divider drag stores its result through core.boundary.move, which is one workbench.layout.change", { timeout: 10000 }, async () => {
  const grid = plane.currentGrid();
  const divider = document.querySelector('.sp-divider[data-axis="x"]');
  const line = Number(divider.dataset.line);
  const from = grid.boundaryPos("x", line);
  const mouse = (target, type, x, buttons) =>
    target.dispatchEvent(new window.MouseEvent(type, { clientX: x, clientY: 100, button: 0, buttons, bubbles: true }));
  mouse(divider, "mousedown", from, 1);
  for (const step of [20, 40, 60]) mouse(document, "mousemove", from + step, 1);
  mouse(document, "mouseup", from + 60, 0);
  // The release runs the command, which ends after the plane drew its result.
  await registry.commandsEnded();
  await flushEvents();
  const events = drag.calls.filter(({ name, payload }) => name === "log" && payload?.action === "batch").flatMap(({ payload }) => payload.events)
    .filter(({ event }) => event === "workbench.layout.change" || event === "workbench.command");
  assert.deepEqual(events.map(({ event, fields }) => [event, fields.command ?? fields.name]), [
    ["workbench.layout.change", "core.boundary.move"],
    ["workbench.command", "core.boundary.move"],
  ]);
  const params = JSON.parse(events[0].fields.params);
  assert.deepEqual(params, { axis: "x", line, position: grid.boundaryPos("x", line) });
  assert.ok(Math.abs(params.position - (from + 60)) < 0.5, `the drag ended at ${params.position}, not ${from + 60}`);
  assert.deepEqual(JSON.parse(events[0].fields.result), { position: params.position });
  drag.finish();
});
