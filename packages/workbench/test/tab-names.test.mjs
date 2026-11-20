// The text of a tab in the tab strip, in the tab list and in the space apps list of the page workbench (docs/spec/example-model.md#card-tabs),
// run through the registry of the page without a host, as in the browser runtime.
import assert from "node:assert/strict";
import test from "node:test";
import { content, PLAIN, plane, reports, row, run, view } from "./support/group-page.mjs";

/** The names that the tab strip of the card id shows, in order. */
const stripNames = (id) => [...document.querySelectorAll(`.card[data-card-id="${id}"] .tab[data-tab-id] .tab__name`)].map((name) => name.textContent);
/** The name and the text beside it of each item of the open list, in order. */
const listItems = () => [...document.querySelectorAll(".picker__item")].map((item) => ({
  name: item.querySelector(".picker__name").textContent, beside: item.querySelector("small").textContent,
}));

// A tab shows one text in the tab strip, in the tab list and in the space apps list: the title that its surface reported, or the mark of
// its plugin and its stored name, and an item of a list shows no second mark.
test("a tab shows one text in the tab strip and in the lists", { timeout: 5000 }, async () => {
  plane.closePicker("fixture reset");
  plane.adopt({ focusedId: "card-1", named: 0, windowSidebars: {}, sidebars: {}, lastCard: 2, leader: "card-1",
    state: { root: row([
      [0.5, content("card-1", [view("tab-bbbbb1", PLAIN), view("tab-bbbbb2", PLAIN)])],
      [0.5, content("card-2", [view("tab-bbbbb3", PLAIN)])],
    ]) } }, "spc-aaaaaa");
  reports.reportTitle("tab-bbbbb1", "notes.md");
  const want = ["notes.md", "f tab-bbbbb2"];
  assert.deepEqual(stripNames("card-1"), want, "the tab strip");
  await run("core.card.tab-list", { card: "card-1" });
  assert.deepEqual(listItems(), want.map((name) => ({ name, beside: "" })), "the tab list differs from the tab strip");
  plane.closePicker("fixture reset");
  await run("core.card.fullscreen", { card: "card-1" });
  await run("core.space.apps", { card: "card-1" });
  assert.deepEqual(listItems(), [...want, "f tab-bbbbb3"].map((name) => ({ name, beside: "" })),
    "the space apps list differs from the tab strip");
  plane.closePicker("fixture reset");
  await run("core.card.fullscreen", { card: "card-1" });
  reports.forgetTab("tab-bbbbb1");
});
