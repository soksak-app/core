// The group tree of a stored space layout in the page workbench (docs/spec/groups.md#storage): the stored check reads groups, leader
// and lastCard with their refusals, a new space starts without groups, and the plane opens the group tree of a layout, issues each new
// card from lastCard and writes the tree back with the layout.
import assert from "node:assert/strict";
import test from "node:test";
import { openVerifyPlane } from "./support/verify-plane.mjs";

const page = await openVerifyPlane();
const { checkStoredLayout } = await import("../stored-layout.js");
const { plane } = page;

/** A content card of a stored layout with the tabs, each of the plugin of the verification page, named by its id and the suffixes. */
const content = (id, c0, c1, r0, r1, suffixes = [""]) => {
  const tabs = suffixes.map((suffix) => ({ id: `tab-${id}${suffix}`, plugin: "fixture-verify", title: `${id}${suffix}` }));
  return { id, c0, c1, r0, r1, data: { tabs, activeId: tabs[0].id } };
};

/** A stored layout of three cards in a row whose first two are the group card-4, as docs/spec/cases/layout/groups.json writes them. */
const grouped = () => ({
  state: { xs: [0, 0.25, 0.5, 1], ys: [0, 1], cards: [content("card-1", 0, 1, 0, 1), content("card-2", 1, 2, 0, 1, ["", "-b"]), content("card-3", 2, 3, 0, 1)] },
  groups: [{ card: "card-4", name: "그룹 1", leader: "card-1", members: ["card-1", "card-2"] }],
  leader: "card-4", lastCard: 4, focusedId: "card-1", named: 0, windowSidebars: {}, sidebars: {},
});

test("the stored check refuses a layout without groups and a group that is not one rectangle", { timeout: 5000 }, () => {
  const { groups: _groups, ...bare } = grouped();
  assert.throws(() => checkStoredLayout(bare), { message: "layout stores groups undefined, which is not a list of groups" });
  const broken = grouped();
  broken.groups[0].members = ["card-1", "card-3"];
  assert.throws(() => checkStoredLayout(broken), { message: "group card-4 does not cover one rectangle of the grid" });
  const { lastCard: _last, ...unnumbered } = grouped();
  assert.throws(() => checkStoredLayout(unnumbered), { message: "layout stores lastCard undefined, which is not the largest issued card number" });
  checkStoredLayout(grouped());
});

test("the stored check refuses a layout with groups whose two lines stand at one coordinate", { timeout: 5000 }, () => {
  const flat = grouped();
  flat.state.xs = [0, 0.25, 0.25, 1];
  assert.throws(() => checkStoredLayout(flat), { message: "layout with groups stores the x lines 1 and 2 at one coordinate; a layout with groups keeps none" });
});

test("a new space stores no groups, the first content card as its leader and a lastCard", { timeout: 5000 }, () => {
  const fresh = plane.fresh();
  assert.deepEqual([fresh.groups, fresh.leader, fresh.lastCard], [[], "main", 1]);
  checkStoredLayout(fresh);
});

test("the plane writes back the group tree it opened and issues a split card from lastCard", { timeout: 5000 }, () => {
  plane.adopt(grouped(), "spc-aaaaaa");
  const kept = plane.capture();
  assert.deepEqual([kept.groups, kept.leader, kept.lastCard], [grouped().groups, "card-4", 4]);
  // A tab moved to a side of a card of two tabs splits that card (dropTab of plane.js).
  plane.moveTab("tab-card-2-b", "card-2", "bottom");
  const after = plane.capture();
  assert.deepEqual(after.state.cards.map((card) => card.id), ["card-1", "card-2", "card-3", "card-5"]);
  assert.equal(after.lastCard, 5);
  assert.deepEqual(after.groups, [{ card: "card-4", name: "그룹 1", leader: "card-1", members: ["card-1", "card-2", "card-5"] }]);
  plane.adopt(plane.fresh(), "spc-aaaaaa");
});
