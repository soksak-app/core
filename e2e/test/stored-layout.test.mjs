import assert from "node:assert/strict";
import test from "node:test";
import { storedCard, storedCards } from "../stored-layout.mjs";

// A cut that holds a card beside a box, whose inner cut holds two cards, as projects.json stores a group card.
const layout = { state: { root: { cut: "x", kids: [{ share: 0.5, node: { card: "other", data: { tabs: [] } } },
  { share: 0.5, node: { box: "group", data: { name: "group", leader: "card" }, inner: { cut: "y", kids: [
    { share: 0.5, node: { card: "card", data: { sidebars: { top: { set: "off" } } } } },
    { share: 0.5, node: { card: "below", data: {} } }] } } }] } } };

test("the stored cards are the card nodes of the tree in its order, through the kids of a cut and the inner node of a box", { timeout: 1000 }, () => {
  assert.deepEqual(storedCards(layout).map((node) => node.card), ["other", "card", "below"]);
  assert.deepEqual(storedCard(layout, "card").data.sidebars, { top: { set: "off" } });
});

test("a stored layout without the card or with a node of another form is an error that names it", { timeout: 1000 }, () => {
  assert.throws(() => storedCard(layout, "missing"), /the stored layout holds no card missing/);
  assert.throws(() => storedCards({ state: { root: { cards: [] } } }), /a node of the stored layout is no card, cut or box/);
});
