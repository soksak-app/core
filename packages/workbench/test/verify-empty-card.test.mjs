// The diagnostic check T5 of verify.js accepts an empty card that the layout keeps, because the layout cannot close it, and fails for an
// empty card that the layout could close (docs/spec/cli.md#acting-on-a-layout).
import assert from "node:assert/strict";
import test from "node:test";
import { content, PLAIN, plane, row, view } from "./support/group-page.mjs";

const { verify } = await import("../verify.js");
// A content card without tabs, as a new project stores it.
const empty = (id) => ({ card: id, data: { tabs: [], activeId: null } });
const t5 = () => verify().find((entry) => entry.name === "T5 빈 카드 0");

test("T5 accepts the empty card of a layout that cannot close it", { timeout: 5000 }, () => {
  plane.adopt({ focusedId: "card-1", named: 0, windowSidebars: {}, sidebars: {}, lastCard: 1, leader: "card-1",
    state: { root: empty("card-1") } }, "spc-aaaaaa");
  assert.equal(t5()?.ok, true, t5()?.note);
});

test("T5 fails for an empty card that the layout could close", { timeout: 5000 }, () => {
  plane.adopt({ focusedId: "card-1", named: 0, windowSidebars: {}, sidebars: {}, lastCard: 2, leader: "card-1",
    state: { root: row([[0.5, content("card-1", [view("tab-aaaaa1", PLAIN)])], [0.5, empty("card-2")]]) } }, "spc-aaaaaa");
  assert.equal(t5()?.ok, false, t5()?.note);
});
