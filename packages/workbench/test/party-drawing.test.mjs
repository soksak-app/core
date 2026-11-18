// Red tests of the drawn party outline, the leader border and the rail (docs/spec/parties.md#drawing). The element names are the ones the
// specification names: the outline is path[data-party="<id>"], the leader border is path[data-party-leader="<id>"] with its stroke, and the
// rail is #railPath. The party module and the party commands do not exist yet, so the test fails on the unchanged implementation at its
// first command.
import assert from "node:assert/strict";
import test from "node:test";
import { openPartyWindow } from "./support/party-window.mjs";

// The segments of an SVG path of M, L and Z commands: each subpath gives its sides, and Z closes the subpath to its first point. A
// command that this reader does not know fails the test.
function pathSides(d) {
  const sides = [];
  let start = null;
  let previous = null;
  const tokens = d.match(/[MLZ]|-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? [];
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i];
    if (command === "M" || command === "L") {
      const point = [Number(tokens[i + 1]), Number(tokens[i + 2])];
      if (command === "M") start = point;
      else sides.push([previous, point]);
      previous = point;
      i += 3;
    } else if (command === "Z") {
      sides.push([previous, start]);
      previous = start;
      i += 1;
    } else {
      throw new Error(`path command ${command} is not read by this test`);
    }
  }
  return sides;
}

const sameSide = (a, b) => (a[0][0] === b[0][0] && a[1][0] === b[1][0] && a[0][1] === b[0][1] && a[1][1] === b[1][1])
  || (a[0][0] === b[1][0] && a[1][0] === b[0][0] && a[0][1] === b[1][1] && a[1][1] === b[0][1]);

// Whether a side of the leader border lies on a side of the party outline: the same axis, the same line and an overlapping extent.
function liesOn(side, outlineSides) {
  return outlineSides.some((other) => {
    const horizontal = side[0][1] === side[1][1];
    if (horizontal !== (other[0][1] === other[1][1])) return false;
    if (horizontal) {
      if (other[0][1] !== side[0][1]) return false;
      const lo = Math.max(Math.min(side[0][0], side[1][0]), Math.min(other[0][0], other[1][0]));
      const hi = Math.min(Math.max(side[0][0], side[1][0]), Math.max(other[0][0], other[1][0]));
      return lo < hi || sameSide(side, other);
    }
    if (other[0][0] !== side[0][0]) return false;
    const lo = Math.max(Math.min(side[0][1], side[1][1]), Math.min(other[0][1], other[1][1]));
    const hi = Math.min(Math.max(side[0][1], side[1][1]), Math.max(other[0][1], other[1][1]));
    return lo < hi || sameSide(side, other);
  });
}

test("the outer outline of a party is one closed path element named by the party", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"] });
    const outline = document.querySelectorAll('path[data-party="p1"]');
    assert.equal(outline.length, 1, "the party has one outline path");
    assert.match(outline[0].getAttribute("d"), /Z\s*$/, "the outline path is closed");
  } finally {
    window.close();
  }
});

test("the leader border of a party is drawn in the leader color", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"], leader: "a", leaderColor: "#123456" });
    const border = document.querySelectorAll('path[data-party-leader="p1"]');
    assert.equal(border.length, 1, "the leader border is drawn");
    assert.equal(border[0].getAttribute("stroke"), "#123456");
  } finally {
    window.close();
  }
});

test("the party outline and the rail do not coincide when they overlap", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"] });
    const outline = document.querySelector('path[data-party="p1"]');
    const rail = document.getElementById("railPath");
    assert.ok(outline && rail, "both paths are drawn");
    assert.notEqual(outline.getAttribute("d"), rail.getAttribute("d"), "the rail and the party outline have the same path");
  } finally {
    window.close();
  }
});

test("the leader border is only the segments of the party outline that the leader card contributes", { timeout: 10000 }, async () => {
  // docs/spec/parties.md#drawing: "The leader card's border segments on the outline are drawn in the leader color".
  const window = await openPartyWindow();
  try {
    await window.reset();
    await window.run("core.party.create", { cards: ["a", "b"], leader: "a", leaderColor: "#123456" });
    const party = await window.run("core.party.get", { party: "p1" });
    const border = document.querySelector('path[data-party-leader="p1"]');
    assert.ok(border, "the leader border is drawn");
    const outlineSides = party.outline.flatMap((loop) => loop.map((point, index) => [point, loop[(index + 1) % loop.length]]));
    const sides = pathSides(border.getAttribute("d"));
    assert.ok(sides.length > 0, "the leader border has sides");
    for (const side of sides) {
      assert.ok(liesOn(side, outlineSides), `the leader border side ${JSON.stringify(side)} lies on the party outline`);
    }
  } finally {
    window.close();
  }
});
