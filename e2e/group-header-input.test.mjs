// A group header takes native pointer input without any activation of the application or of its window: a press on the header,
// drags over another card and the release move the group card (docs/spec/groups.md#moving-and-dropping), and a double-click on
// the name of the group begins its rename (docs/spec/groups.md#headers), in a new window and after a dissolve and a create in the
// same window. The window stands behind the windows of the person (`host.window.lower`), and no input of the check is a move or an
// activation, so the window never becomes the key window or the virtual key window: each press goes directly to the view under
// the point (docs/spec/exposure.md#methods). The group card leads the root level and moves inside it, so it keeps the leader mark
// (docs/spec/groups.md#leader).
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh, START_PLUGIN } from "./fixture.mjs";

/** The window point of the fraction (fx, fy) of the drawn rectangle of the card or group card id of `core.grid`. */
function gridPoint(grid, id, fx, fy) {
  const box = [...grid.cards, ...grid.groups].find((item) => item.id === id);
  if (!box) throw new Error(`core.grid holds no card ${id}: ${JSON.stringify(grid)}`);
  return { x: Math.round(grid.plane.x + box.x + box.w * fx), y: Math.round(grid.plane.y + box.y + box.h * fy) };
}

/**
 * Double-clicks the name of the group card group: two clicks, the second with the click count 2, through the connection of s.
 * A release answers after the workbench handled it, as the receipt of a main page or the frame of the native workbench of mygo
 * tells (docs/spec/exposure.md#methods), and the release of a double-click begins the rename, so the rename has begun when the
 * release answers.
 */
async function doubleClickName(s, group, what) {
  const name = await s.rect("core.group.name");
  const at = { x: Math.round(name.x + 12), y: Math.round(name.y + name.height / 2) };
  await s.pointer(at.x, at.y, "down");
  await s.pointer(at.x, at.y, "up");
  await s.pointer(at.x, at.y, "down", { clicks: 2 });
  await s.pointer(at.x, at.y, "up", { clicks: 2 });
  const rename = await s.get("core.rename");
  assert.ok(rename?.kind === "group" && rename.id === group, `${what}: the rename of ${group} had not begun when the release of ` +
    `the double-click answered: core.rename ${JSON.stringify(rename)}, core.pointer ${JSON.stringify(await s.get("core.pointer"))}`);
  await s.run("core.rename.cancel");
  await s.until("core.rename", (value) => value === null, `${what}: the rename did not end`);
}

/** Asserts that the window is neither the key window nor the virtual key window of the application, which stays inactive. */
async function notActivated(s, what) {
  const state = await s.get("host.window");
  assert.equal(state.key, false, `${what}: the window became the key window`);
  assert.equal(state.virtualKey, false, `${what}: the window became the virtual key window`);
  assert.equal(state.active, false, `${what}: the application became active`);
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a group header takes a drag and a double-click on its name without activation`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app, { inactive: true });
    await fresh(s);
    await s.run("host.window.lower");
    // The group card of the leader of the root level takes its leader mark (docs/spec/groups.md#leader).
    const start = await s.get("core.layout");
    const created = await s.run("core.group.create", { card: start.leader, side: "right", plugin: START_PLUGIN });
    const { group } = created;
    await s.until("core.layout", (layout) => layout.groups.some((item) => item.card === group), `the group ${group} was not created`);
    await s.presented();
    await notActivated(s, "after the window was lowered");

    await doubleClickName(s, group, "a new window");
    await notActivated(s, "after the double-click");

    // A press on the header, drags to the bottom zone of a card of the root level outside the group and the release.
    const before = await s.get("core.layout");
    assert.equal(before.leader, group, "the group card took the leader mark of the card that it grouped");
    const members = before.groups.find((item) => item.card === group).members;
    const grid = await s.get("core.grid");
    const target = grid.cards.find((card) => !card.fixed && card.parent === null && !members.includes(card.id));
    if (!target) throw new Error(`the start layout holds no content card of the root level outside ${group}: ${JSON.stringify(grid)}`);
    const header = await s.rect("core.group.header");
    const press = { x: Math.round(header.x + 24), y: Math.round(header.y + header.height / 2) };
    const drop = gridPoint(grid, target.id, 0.5, 0.9);
    await s.pointer(press.x, press.y, "down");
    for (const fraction of [0.25, 0.5, 0.75, 1]) {
      await s.pointer(Math.round(press.x + (drop.x - press.x) * fraction), Math.round(press.y + (drop.y - press.y) * fraction), "drag");
    }
    await s.until("core.drag", (drag) => drag?.card === group && drag.tab === "" && drag.target?.card === target.id
      && drag.target.zone === "bottom", `the drag of the header of ${group} over the bottom of ${target.id} reported no drag of the group card`);
    await s.pointer(drop.x, drop.y, "up");
    await s.until("core.drag", (drag) => drag === null, "the drag did not end at the release");
    const moved = await s.until("core.grid", (now) => {
      const box = now.groups.find((item) => item.id === group);
      const below = now.cards.find((item) => item.id === target.id);
      return box && below && box.y > below.y;
    }, `the release did not move ${group} below ${target.id}`);
    const after = await s.get("core.layout");
    assert.equal(after.leader, group, `the move of ${group} inside the root level changed its leader to ${after.leader}`);
    assert.ok(moved.groups.some((item) => item.id === group && item.parent === null), `${group} left the root level`);
    await notActivated(s, "after the drag");

    // A dissolve and a create in the same window, then at once a double-click on the name of the new group card (F937-59).
    await s.run("core.group.dissolve", { group });
    await s.until("core.layout", (layout) => layout.groups.length === 0, `the dissolve of ${group} left a group`);
    const again = (await s.run("core.group.create", { card: (await s.get("core.layout")).leader, side: "right", plugin: START_PLUGIN })).group;
    await s.until("core.layout", (layout) => layout.groups.some((item) => item.card === again), `the group ${again} was not created`);
    await s.presented();
    await doubleClickName(s, again, "after a dissolve and a create");
    await notActivated(s, "after the double-click on the new group card");
  });
}
