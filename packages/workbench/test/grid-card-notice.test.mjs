// The core.grid card reports its newest notice and its footer status, which is null while the notice shows (docs/spec/notifications.md#card-status-line).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { matchesSchema } from "@soksak/plugin-api";

const exposure = JSON.parse(readFileSync(new URL("../exposure.json", import.meta.url), "utf8")).exposes;
const grid = exposure.status.find((entry) => entry.name === "core.grid");
const card = grid.schema.properties.cards.items;
const CARD = {
  fullscreen: false, id: "card-1", x: 0, y: 0, w: 320, h: 240, c0: 0, c1: 1, r0: 0, r1: 1, fixed: false, width: null, focused: true, pane: 0,
  tabs: [], active: null, acts: null,
};

test("a card whose notice shows reports the notice and a null status", () => {
  const notice = { id: "notice-1", kind: "info", title: "Built" };
  assert.equal(matchesSchema(card, { ...CARD, notice, status: null }), true);
});

test("a card without a notice reports a null notice and the text of its footer", () => {
  assert.equal(matchesSchema(card, { ...CARD, notice: null, status: "idle" }), true);
});

test("the notice of a card holds an id, one of the five kinds and a title", () => {
  assert.equal(matchesSchema(card, { ...CARD, notice: { id: "notice-1", kind: "loud", title: "Built" }, status: "idle" }), false);
  assert.equal(matchesSchema(card, { ...CARD, notice: "Built", status: "idle" }), false);
});
