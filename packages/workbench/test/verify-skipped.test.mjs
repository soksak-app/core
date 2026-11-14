// A check that has nothing to measure in a state is no pass: it is stated as skipped.
// The plane and the compositor are the modules of the page, which runs without an application host.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openVerifyPlane } from "./support/verify-plane.mjs";

const page = await openVerifyPlane();
after(() => page.close());

test("a single empty plane before any commit states the checks that measured nothing as skipped", { timeout: 5000 }, () => {
  // JSDOM has no layout, so the card has no room for its head and foot rows of the declared heights, and the check of the drop zones
  // measures no card.
  const sheet = document.createElement("style");
  sheet.textContent = ":root { --head-h: 40px; --foot-h: 30px; }";
  document.head.appendChild(sheet);
  try {
    check(page.verify());
  } finally {
    sheet.remove();
  }
});

function check(rows) {
  const skipped = rows.filter((row) => row.skipped).map((row) => row.name.split(" ")[0]);
  assert.deepEqual(skipped, ["V0", "V1", "V3", "V6", "V7a", "V7c", "V7b", "V9", "V10", "R", "D", "P", "W"]);
  for (const row of rows) {
    if (row.skipped) {
      assert.equal(row.ok, undefined, `${row.name} states a pass`);
      assert.ok(row.note, `${row.name} does not say why`);
    }
  }
}
