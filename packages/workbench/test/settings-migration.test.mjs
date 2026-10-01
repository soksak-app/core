import assert from "node:assert/strict";
import test from "node:test";

import { migrateSettings } from "../settings-migration.js";

test("earlier links become card-left and window links, and a plugin link without a set is dropped", () => {
  const values = { gap: 8, cardSidebar: "inset", links: [
    { place: "left", plugin: null, set: "set-a" },
    { place: "rail", plugin: "plugin-a", set: "set-b" },
    { place: "right", plugin: "plugin-a", set: "set-c" },
    { place: "left", plugin: "plugin-b", set: null },
    { place: "card-top", plugin: "plugin-a", set: "set-b" },
  ] };
  const { patch, notes } = migrateSettings(values);
  assert.deepEqual(Object.keys(patch), ["cardSidebar", "links"]);
  assert.equal(patch.cardSidebar, undefined);
  assert.deepEqual(patch.links, [
    { place: "left", plugin: null, set: "set-a" },
    { place: "card-left", plugin: "plugin-a", set: "set-b" },
    { place: "window-right", plugin: "plugin-a", set: "set-c" },
    { place: "card-top", plugin: "plugin-a", set: "set-b" },
  ]);
  assert.deepEqual(notes, [
    "removed cardSidebar because they are no longer settings",
    "the rail link of plugin-a became card-left",
    "the right link of plugin-a became window-right",
    "the left link of plugin-b without a set was dropped because a window override requires a set",
  ]);
  assert.equal(values.links[1].place, "rail", "the stored input was changed in place");
});

test("current settings produce no change", () => {
  assert.deepEqual(migrateSettings({ gap: 8, links: [{ place: "window-left", plugin: "plugin-a", set: "set-a" }] }),
    { patch: {}, notes: [] });
});
