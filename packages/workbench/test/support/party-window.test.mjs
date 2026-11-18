// Test of the page window of the party tests (party-window.mjs). A test calls close in its finally block, and the next test of the same
// process reads the plane element that the page loaded. The close must keep the document, or the plane element that the page holds is
// removed from the document.
import assert from "node:assert/strict";
import test from "node:test";
import { openPartyWindow } from "./party-window.mjs";

test("closing a test window keeps the plane element of the page in the document", { timeout: 10000 }, async () => {
  const window = await openPartyWindow();
  window.close();
  assert.notEqual(document.getElementById("plane"), null);
});
