// Test of the rule of the rail and the party outline (docs/spec/parties.md#drawing): both lines stay at their places, the rail is drawn over
// the party line, and no party colour shows outside the rail. The row is the card a, the card b and the window sidebar right, whose
// override link of probe-plain joins the focused card a with the rail. The party of a and b has its leader a, the focused card, so the rail
// outlines a on the sides where the party outline also runs. The rail is read from core.rail, the loops that #railPath draws with the
// stroke width bw of the theme, and the party outline from the drawn path[data-party="p1"], whose stroke width is the party width.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CHROME } from "../chrome-metrics.js";
import { borderWidth } from "../settings.js";
import { openPartyWindow } from "./support/party-window.mjs";

// The party width, the stroke of the party outline (packages/workbench/parties.js BORDER).
const PARTY_WIDTH = parseFloat(CHROME["theme-rail-w"]);
const SAME = 0.01;

/** The axis sides of an SVG path of M, L and Z commands, each `{vertical, at, from, to}`. */
function pathSides(d) {
  const segments = [];
  let start = null;
  let previous = null;
  const tokens = d.match(/[MLZ]|-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? [];
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i];
    if (command === "M" || command === "L") {
      const point = [Number(tokens[i + 1]), Number(tokens[i + 2])];
      if (command === "M") start = point;
      else segments.push([previous, point]);
      previous = point;
      i += 3;
    } else if (command === "Z") {
      segments.push([previous, start]);
      previous = start;
      i += 1;
    } else {
      throw new Error(`path command ${command} is not read by this test`);
    }
  }
  return axisSides(segments);
}

/** The axis sides of the loops of core.rail, whose points are `{x, y}`. */
const loopSides = (loops) => axisSides(loops.flatMap((loop) => loop.map((point, index) => {
  const next = loop[(index + 1) % loop.length];
  return [[point.x, point.y], [next.x, next.y]];
})));

function axisSides(segments) {
  const sides = [];
  for (const [a, b] of segments) {
    if (Math.abs(a[0] - b[0]) < SAME && Math.abs(a[1] - b[1]) >= SAME) sides.push({ vertical: true, at: a[0], from: Math.min(a[1], b[1]), to: Math.max(a[1], b[1]) });
    else if (Math.abs(a[1] - b[1]) < SAME && Math.abs(a[0] - b[0]) >= SAME) sides.push({ vertical: false, at: a[1], from: Math.min(a[0], b[0]), to: Math.max(a[0], b[0]) });
  }
  return sides;
}

const overlap = (a, b) => Math.min(a.to, b.to) - Math.max(a.from, b.from);

/** Adds the stylesheet of the page, which gives the layers their stacking order; JSDOM does not load the stylesheet link of index.html. */
function addStylesheet() {
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("../app.css", import.meta.url), "utf8");
  document.head.append(style);
}
const stack = (element) => Number.parseInt(getComputedStyle(element).zIndex, 10) || 0;

// contract: workbench.parties.drawing
test("no party colour shows outside the rail of a focused leader and the rail is drawn over the party line", { timeout: 10000 }, async () => {
  const window = await openPartyWindow(["a", "b", "right"], { overrides: true });
  addStylesheet();
  try {
    await window.reset();
    await window.run("core.card.focus", { card: "b" });
    await window.run("core.party.create", { cards: ["a", "b"], leader: "a" });
    // core.parties does not change with the focus (docs/spec/parties.md#queries).
    const before = JSON.stringify((await window.get("core.parties")).result);
    await window.run("core.card.focus", { card: "a" });
    assert.equal(JSON.stringify((await window.get("core.parties")).result), before, "core.parties changed with the focus");

    const rail = (await window.get("core.rail")).result;
    assert.ok(rail.groups.some((item) => item.card === "a"), `the rail has no group of the focused card a: ${JSON.stringify(rail.groups)}`);
    const drawn = document.querySelector('path[data-party="p1"]');
    assert.ok(drawn, "the party outline is drawn");
    const railSides = loopSides(rail.groups.flatMap((item) => item.loops));
    const partySides = pathSides(drawn.getAttribute("d"));
    const grid = (await window.get("core.grid")).result;
    const card = grid.cards.find((item) => item.id === "a");
    // Each edge with the sign of the direction out of the card.
    const edges = [
      { vertical: true, at: card.x, outward: -1, from: card.y, to: card.y + card.h },
      { vertical: true, at: card.x + card.w, outward: 1, from: card.y, to: card.y + card.h },
      { vertical: false, at: card.y, outward: -1, from: card.x, to: card.x + card.w },
      { vertical: false, at: card.y + card.h, outward: 1, from: card.x, to: card.x + card.w },
    ];
    const near = (side, edge) => side.vertical === edge.vertical && Math.abs(side.at - edge.at) <= grid.gap / 2 + SAME && overlap(side, edge) >= SAME;
    const bw = borderWidth();
    const outside = [];
    let compared = 0;
    for (const edge of edges) {
      for (const railSide of railSides.filter((side) => near(side, edge))) {
        for (const partySide of partySides.filter((side) => near(side, edge) && overlap(side, railSide) >= SAME)) {
          compared += 1;
          // The outer edge of the rail band and of the party band, as distances out of the card.
          const railOuter = (railSide.at - edge.at) * edge.outward + bw / 2;
          const partyOuter = (partySide.at - edge.at) * edge.outward + PARTY_WIDTH / 2;
          if (railOuter - partyOuter < -SAME) outside.push({ edge, railSide, partySide, railOuter, partyOuter });
        }
      }
    }
    assert.ok(compared > 0, `no side of the party outline lies on an edge of a that the rail outlines: rail ${JSON.stringify(railSides)}, party ${JSON.stringify(partySides)}`);
    assert.deepEqual(outside, [], `the party band reaches outside the rail band (rail stroke ${bw}, party stroke ${PARTY_WIDTH})`);

    // The rail is drawn over the party line: the rail layer stacks above the party layer.
    const layer = drawn.ownerSVGElement;
    const railLayer = document.getElementById("rail");
    assert.ok(stack(railLayer) > stack(layer), `the rail layer (z-index ${stack(railLayer)}) is not above the party layer (z-index ${stack(layer)})`);
  } finally {
    window.close();
  }
});
