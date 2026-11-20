// The group tree of a stored space layout in the page workbench (docs/spec/groups.md#storage): the stored check reads the boxes of the
// tree, leader and lastCard with their refusals, a new space starts without a box, and the plane opens the group tree of a layout, issues
// each new card from lastCard and writes the tree back with the layout.
import assert from "node:assert/strict";
import test from "node:test";
import { openVerifyPlane } from "./support/verify-plane.mjs";

const page = await openVerifyPlane();
const { checkStoredLayout } = await import("../stored-layout.js");
const { plane } = page;

/** A content card node of a stored layout with the tabs, each of the plugin of the verification page, named by its id and the suffixes. */
const content = (id, suffixes = [""]) => {
  const tabs = suffixes.map((suffix) => ({ id: `tab-${id}${suffix}`, plugin: "fixture-verify", title: `${id}${suffix}` }));
  return { card: id, data: { tabs, activeId: tabs[0].id } };
};

/** A stored layout of three cards in a row whose first two are the group card-4, a box of the tree, as docs/spec/cases/layout/groups.json writes them. */
const grouped = () => ({
  state: { root: { cut: "x", kids: [
    { share: 0.5, node: { box: "card-4", data: { name: "그룹 1", leader: "card-1" }, inner: { cut: "x", kids: [
      { share: 0.5, node: content("card-1") }, { share: 0.5, node: content("card-2", ["", "-b"]) },
    ] } } },
    { share: 0.5, node: content("card-3") },
  ] } },
  leader: "card-4", lastCard: 4, focusedId: "card-1", named: 0, windowSidebars: {}, sidebars: {},
});
const groupBox = (layout) => layout.state.root.kids[0].node;

test("the stored check reads the group cards from the boxes of the tree with the refusals of the storage", { timeout: 5000 }, () => {
  checkStoredLayout(grouped());
  assert.throws(() => checkStoredLayout({ ...grouped(), groups: [] }),
    { message: "layout stores groups, the group list of the earlier form; the group cards are boxes of state" });
  const data = grouped();
  groupBox(data).data = { name: "그룹 1" };
  assert.throws(() => checkStoredLayout(data), { message: 'layout stores the group card-4 with the data {"name":"그룹 1"}, which is not {name, leader}' });
  const named = grouped();
  groupBox(named).data.name = "";
  assert.throws(() => checkStoredLayout(named), { message: 'group card-4 stores the name "", which is not 1 to 40 characters' });
  const led = grouped();
  groupBox(led).data.leader = "card-3";
  assert.throws(() => checkStoredLayout(led), { message: "level group card-4 names the leader card-3, which is not a member of that level" });
  const { leader: _leader, ...leaderless } = grouped();
  assert.throws(() => checkStoredLayout(leaderless), { message: "level root has no leader" });
  const { lastCard: _last, ...unnumbered } = grouped();
  assert.throws(() => checkStoredLayout(unnumbered), { message: "layout stores lastCard undefined, which is not the largest issued card number" });
  assert.throws(() => checkStoredLayout({ ...grouped(), lastCard: 3 }), { message: "layout stores lastCard 3, which is not the largest issued card number" });
});

test("a new space stores the tree without a box, the first content card as its leader and a lastCard", { timeout: 5000 }, () => {
  const fresh = plane.fresh();
  assert.equal(Object.hasOwn(fresh, "groups"), false, "a new space stores the group list of the earlier form");
  assert.deepEqual([fresh.state.root.card, fresh.leader, fresh.lastCard], ["main", "main", 1]);
  checkStoredLayout(fresh);
});

test("the plane writes back the boxes of the tree it opened and issues a split card from lastCard", { timeout: 5000 }, () => {
  plane.adopt(grouped(), "spc-aaaaaa");
  const kept = plane.capture();
  assert.equal(Object.hasOwn(kept, "groups"), false, "the plane stores the group list of the earlier form");
  assert.deepEqual([groupBox(kept).box, groupBox(kept).data, kept.leader, kept.lastCard], ["card-4", { name: "그룹 1", leader: "card-1" }, "card-4", 4]);
  // A tab moved to a side of a card of two tabs splits that card inside its box (dropTab of plane.js).
  plane.moveTab("tab-card-2-b", "card-2", "bottom");
  const after = plane.capture();
  assert.equal(after.lastCard, 5);
  const inner = groupBox(after).inner;
  assert.deepEqual(inner.kids.map(({ node }) => node.card ?? node.kids.map((kid) => kid.node.card)), ["card-1", ["card-2", "card-5"]]);
  plane.adopt(plane.fresh(), "spc-aaaaaa");
});
