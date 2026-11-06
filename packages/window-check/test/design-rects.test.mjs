import assert from "node:assert/strict";
import test from "node:test";

import { designDifferences } from "../design-rects.mjs";

const box = (x, y, width, height) => ({ x, y, width, height });

test("places within the tolerance on every host are no difference", () => {
  const readings = {
    mygo: { shell: { "core.brand": [box(10, 4, 60, 20.6)] } },
    wailsv3: { shell: { "core.brand": [box(10.5, 4, 60, 20)] } },
    tauriv2: { shell: { "core.brand": [box(10, 3.2, 60.4, 20)] } },
  };
  assert.deepEqual(designDifferences(readings), []);
});

test("a place that one host moves past the tolerance is a difference that names every host", () => {
  const readings = {
    mygo: { shell: { "core.card.tab": [box(0, 0, 80, 28), box(80, 0, 80, 30)] } },
    wailsv3: { shell: { "core.card.tab": [box(0, 0, 80, 28), box(80, 0, 80, 28)] } },
    tauriv2: { shell: { "core.card.tab": [box(0, 0, 80, 28), box(80, 0, 80, 28)] } },
  };
  assert.deepEqual(designDifferences(readings),
    ["shell core.card.tab[1]: mygo 80,0 80x30; wailsv3 80,0 80x28; tauriv2 80,0 80x28"]);
});

test("an element that one host does not show is a difference", () => {
  const readings = {
    mygo: { picker: { "core.picker.item": [box(5, 5, 100, 24)] } },
    wailsv3: { picker: { "core.picker.item": [box(5, 5, 100, 24), box(5, 29, 100, 24)] } },
    tauriv2: { picker: {} },
  };
  assert.deepEqual(designDifferences(readings), [
    "picker core.picker.item[0]: mygo 5,5 100x24; wailsv3 5,5 100x24; tauriv2 absent",
    "picker core.picker.item[1]: mygo absent; wailsv3 5,29 100x24; tauriv2 absent",
  ]);
});

test("a state that one host did not reach is a difference", () => {
  const readings = { mygo: { shell: {} }, wailsv3: { shell: {}, library: {} }, tauriv2: { shell: {}, library: {} } };
  assert.deepEqual(designDifferences(readings), ["library: not reached on mygo"]);
});
