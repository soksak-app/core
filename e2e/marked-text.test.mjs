// Confirms that, when a composition that keeps its text marked ends, the native input client of an image region commits that string
// exactly once and its sidecar receives it once (F8-7), that the region presents the frame that the sidecar drew after the marked
// text and after the commit, and that each native input transaction that the event log records reaches the sidecar unchanged under
// its correlation identifiers. The image region is that of the raster probe, whose `rasterprobe.input` logs each input transaction
// with the echo of its sidecar and the frame that presents it.
//
// The Japanese (romaji) input method keeps the typed kana as marked text and, when the input source changes, AppKit ends the
// composition with `unmarkText` (F8-7). The check gives the client those steps with input.text, as the input method gives them to
// the key window of an active application (docs/spec/exposure.md#methods): the marked text after each romaji key of `n i h o n n`,
// and `unmark`. The window stays covered and the application inactive.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { assertReceivedUnchanged, focusImage, insertedText, lastTransaction, presentedStage, rasterProbeTab,
  receivedAfter } from "./input-probe.mjs";
import { NATIVE_INPUT_LOG, NATIVE_INPUT_READS, nativeInputDelivered, nativeInputStart } from "./native-input-trace.mjs";

/** The marked text that the Japanese (romaji) input method shows after each key of `n i h o n n`. */
const MARKED = ["n", "に", "にh", "にほ", "にほn", "にほん"];

for (const app of Object.values(APPS)) {
  test(`${app.name}: marked text that the input method ends is committed to the sidecar once`,
    { timeout: 60000 }, async (t) => {
      const s = await open(t, app);
      await fresh(s, { log: { ...NATIVE_INPUT_LOG }, reads: ["native.input.callback", ...NATIVE_INPUT_READS] });
      const { surface } = await rasterProbeTab(s);
      await focusImage(s, surface);
      const offsets = nativeInputStart(s);
      const start = await lastTransaction(s, surface);

      for (const text of MARKED) {
        await s.text("mark", text);
        await s.until("rasterprobe.input", (input) => input.preedit?.text === text,
          `the image region did not show the marked text ${JSON.stringify(text)}`, { surface });
      }
      const marked = MARKED.at(-1);
      await presentedStage(s, surface, `the marked text ${marked}`);
      const composing = await receivedAfter(s, surface, start, "the sidecar did not echo the composing transactions");
      assert.equal(insertedText(composing), "", `marked text ${JSON.stringify(marked)} was committed before the composition ended`);

      // The change of the input source ends the composition, and AppKit commits the marked text with unmarkText.
      await s.text("unmark");
      await s.until("rasterprobe.input", (input) => input.preedit?.text === "", "the ended composition left a preedit", { surface });
      const composed = await receivedAfter(s, surface, start, "the sidecar did not echo the transactions");
      const expected = composed.map((entry) => entry.preedit.text).filter((text) => text !== "").at(-1);
      assert.equal(expected, marked, "the log does not end its marked text with the last marked text");
      const log = await s.until("rasterprobe.input", (input) => insertedText(input.log.filter((entry) => entry.sequence > start)) === expected,
        `the ended composition did not commit ${expected}`, { surface }).then(() => receivedAfter(s, surface, start,
        "the sidecar did not echo the commit"));
      await presentedStage(s, surface, `the commit of ${expected}`);
      assertReceivedUnchanged(log, `${app.name} marked text`);
      await nativeInputDelivered(s, surface, offsets, start, `${app.name} marked text`);
      const inserts = log.filter((entry) => entry.actions.some((action) => action.type === "insert"));
      const committed = inserts.flatMap((entry) => entry.actions.filter((action) => action.type === "insert").map((action) => action.text));
      t.diagnostic(`${app.name}: marked ${JSON.stringify(log.map((entry) => entry.preedit.text).filter((text) => text !== ""))}, inserts ${JSON.stringify(committed)}`);
      assert.deepEqual(committed, [expected], "the native client did not commit the marked text exactly once");
      const commit = inserts[0].sequence;
      assert.ok(!log.some((entry) => entry.sequence > commit && entry.preedit.text !== ""), "a preedit followed the commit");
      t.diagnostic(`${app.name}: PASS ${expected} committed once`);
    });
}
