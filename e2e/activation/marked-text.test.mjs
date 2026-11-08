// Confirms that, when the composition of a macOS Japanese input method that uses marked text ends, the native input client of an
// image region commits that string exactly once and its sidecar receives it once (F8-7). The image region is that of the raster
// probe, whose `rasterprobe.input` logs each input transaction with the echo of its sidecar.
//
// The Japanese (romaji) input method keeps the typed kana as marked text (and converts it to kanji when live conversion is on),
// and ends the composition when the input source changes. The expected committed string is the marked text that the input method
// reported last. The subject is the marked text of the OS input method and the end of its composition at a change of the input
// source, which the input method gives only the key window of the active application
// (docs/spec/exposure.md#virtual-key-window), so this check activates the application, switches the input source through
// diagnostics.input.source of the diagnostic build and restores the previous source at the end. It fails when the input source
// is not enabled.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { assertReceivedUnchanged, insertedText, lastTransaction, rasterProbeTab, receivedAfter } from "../input-probe.mjs";
import { focusImageActive } from "./image-focus.mjs";

for (const app of Object.values(APPS)) {
  test(`${app.name}: marked text that the input method ends is committed to the sidecar once`,
    { timeout: 60000 }, async (t) => {
      const s = await open(t, app);
      await fresh(s, { log: { input: "info" }, reads: ["native.input.key_down", "native.input.callback"] });
      const { surface } = await rasterProbeTab(s);

      const original = (await s.request("diagnostics.input.source")).source;
      s.cleanup(() => s.request("diagnostics.input.source", { restore: original }));
      await focusImageActive(s, surface);
      const start = await lastTransaction(s, surface);

      assert.equal((await s.request("diagnostics.input.source", { select: "japanese" })).current, "japanese",
        `the japanese input source is not enabled`);
      for (const key of ["n", "i", "h", "o", "n", "n"]) await s.press(key);
      // No romaji remains in the marked text after the last n.
      const marked = (await s.until("rasterprobe.input", (input) => input.preedit !== null && input.preedit.text.length > 0
        && !/[a-z]/.test(input.preedit.text), "the input method did not show marked text for nihonn", { surface })).preedit.text;
      const composing = await receivedAfter(s, surface, start, "the sidecar did not echo the composing transactions");
      assert.equal(insertedText(composing), "", `marked text ${JSON.stringify(marked)} was committed before the composition ended`);

      // When the input source changes, the input method ends the composition and AppKit commits the marked text.
      assert.equal((await s.request("diagnostics.input.source", { select: "latin" })).current, "latin");
      await s.until("rasterprobe.input", (input) => input.preedit?.text === "", "the ended composition left a preedit", { surface });
      const composed = (await receivedAfter(s, surface, start, "the sidecar did not echo the transactions"));
      const expected = composed.map((entry) => entry.preedit.text).filter((text) => text !== "").at(-1);
      assert.ok(expected, "the log has no marked text");
      const log = await s.until("rasterprobe.input", (input) => insertedText(input.log.filter((entry) => entry.sequence > start)) === expected,
        `the ended composition did not commit ${expected}`, { surface }).then(() => receivedAfter(s, surface, start,
        "the sidecar did not echo the commit"));
      assertReceivedUnchanged(log, `${app.name} marked text`);
      const inserts = log.filter((entry) => entry.actions.some((action) => action.type === "insert"));
      const committed = inserts.flatMap((entry) => entry.actions.filter((action) => action.type === "insert").map((action) => action.text));
      t.diagnostic(`${app.name}: marked ${JSON.stringify(log.map((entry) => entry.preedit.text).filter((text) => text !== ""))}, inserts ${JSON.stringify(committed)}`);
      assert.deepEqual(committed, [expected], "the native client did not commit the marked text exactly once");
      const commit = inserts[0].sequence;
      assert.ok(!log.some((entry) => entry.sequence > commit && entry.preedit.text !== ""), "a preedit followed the commit");
      t.diagnostic(`${app.name}: PASS ${expected} committed once`);
    });
}
