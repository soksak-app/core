// The native modal reports the scroll position of its content, which is negative while the content is pulled past its start
// (the overscroll of a trackpad). A position is a measurement and not a command, so it is kept as reported; only a value that
// is not a number is refused (docs/spec/debug.md). The modal reports each position as the host notice `overlay-pick`, which the page-wire
// case `debug-scroll-reports` delivers (docs/spec/cases/page-wire/README.md).
import assert from "node:assert/strict";
import test from "node:test";
import { openDebugView } from "./support/debug-document.mjs";

test("a negative scroll position of the native modal is kept as reported and a value that is not a number is refused", async () => {
  const { ui, wire, close } = await openDebugView("debug-scroll-reports");
  try {
    for (const reported of ["12", "-1", "-3.5", "0"]) {
      wire.deliverNotice();
      assert.equal(ui.debugState().scroll, Number(reported), `the position ${reported} was not kept`);
    }
    for (const invalid of ["abc", "NaN", "Infinity", ""]) {
      assert.throws(() => wire.deliverNotice(), /debug scroll position is not a number/, invalid);
    }
  } finally {
    await close();
  }
  wire.finish();
});
