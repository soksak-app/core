// Types Hangul into an image region through the real macOS Korean input method and checks its preedit, its commits and its
// selected end as the native input client of core reports them, that the image region presents the frame that the sidecar drew after
// each stage of a composition, and that the sidecar of the region receives each native input transaction that the event log records
// once and unchanged under its correlation identifiers. The image region is that of the raster probe, whose `rasterprobe.input` logs
// each transaction with the echo of its sidecar and the frame that presents it. The subject is the composition of the OS input method, which serves only the key window of the active application
// and composes nothing for the virtual key window (docs/spec/exposure.md#virtual-key-window), so this check activates the application
// and switches the input source through diagnostics.input.source of the diagnostic build, restoring the previous source at the end.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { compareAppKitReference } from "./ime-reference-steps.mjs";
import { assertReceivedUnchanged, inputDocument, insertedText, lastTransaction, presentedStage, rasterProbeTab,
  receivedAfter, transactionMatchesKey, typedText, untilDocument } from "../input-probe.mjs";
import { focusImageActive } from "./image-focus.mjs";
import { NATIVE_INPUT_LOG, NATIVE_INPUT_READS, nativeInputDelivered, nativeInputStart } from "./native-input-trace.mjs";

const JAMO = /[ㄱ-ㅣ]/;

/** Opens a raster probe tab, keeps the input source of the person for the cleanup, and gives its image region the keyboard. */
async function focusedRegion(s) {
  const { surface } = await rasterProbeTab(s);
  const original = (await s.request("diagnostics.input.source")).source;
  s.cleanup(() => s.request("diagnostics.input.source", { restore: original }));
  await focusImageActive(s, surface);
  return surface;
}

/**
 * Waits until the preedit of the image region of `surface` satisfies the predicate and the region presents the frame of that stage
 * (presentedStage), and returns the preedit.
 */
async function preeditUntil(s, surface, predicate, message) {
  const { preedit } = await s.until("rasterprobe.input", (input) => input.preedit !== null && predicate(input.preedit), message, { surface });
  await presentedStage(s, surface, message);
  return preedit;
}

/** Waits until the transactions after `after` typed `text` at their end (typedText) and the region presents that stage. */
async function typedUntil(s, surface, after, text, message) {
  await s.until("rasterprobe.input", (input) => typedText(input.log.filter((entry) => entry.sequence > after)).endsWith(text),
    message, { surface });
  await presentedStage(s, surface, message);
}

/** Waits until the transactions after `after` leave `expected` as their document (untilDocument) and the region presents that stage. */
async function documentUntil(s, surface, after, expected, message) {
  await untilDocument(s, surface, after, expected, message);
  await presentedStage(s, surface, message);
}

/** The log policy and the records of a check of this file: the input records of the native library and the sidecar requests. */
const READS = ["native.input.key_down", "native.input.callback", ...NATIVE_INPUT_READS];

for (const app of Object.values(APPS)) {
  test(`${app.name}: a Korean syllable typed right after an input-source switch reaches the sidecar once`,
    { timeout: 60000 }, async (t) => {
      const s = await open(t, app);
      await fresh(s, { log: { ...NATIVE_INPUT_LOG }, reads: READS });
      const surface = await focusedRegion(s);
      const offsets = nativeInputStart(s);
      const start = await lastTransaction(s, surface);

      // Order from the user report: ddd with the English layout, then Hangul with the Korean 2-set layout (g k s r m f), Space, Enter.
      assert.equal((await s.request("diagnostics.input.source", { select: "latin" })).current, "latin");
      for (const typed of ["d", "dd", "ddd"]) {
        await s.press("d");
        await typedUntil(s, surface, start, typed, `the latin key did not produce ${typed}`);
      }
      assert.equal((await s.request("diagnostics.input.source", { select: "korean" })).current, "korean");

      const steps = [["g", "ㅎ"], ["k", "하"], ["s", "한"], ["r", "ㄱ"], ["m", "그"], ["f", "글"]];
      for (const [key, preedit] of steps) {
        await s.press(key);
        const compose = await preeditUntil(s, surface, (value) => value.text === preedit ||
          (value.text === `한${preedit}` && ["ㄱ", "그", "글"].includes(preedit)), `the ${key} key did not show the ${JSON.stringify(preedit)} preedit`);
        // The selection range of the input method points after the composed text.
        if (preedit === "글") {
          assert.equal(compose.selectedRange?.location, compose.text.length, "the input method did not select the end of the preedit");
        }
      }
      // F8-16: Space is a key that the input method does not handle, so the text and the space reach the sidecar without a following key.
      await s.press("Space");
      await preeditUntil(s, surface, (value) => value.text === "", "the Space key left a preedit");
      await documentUntil(s, surface, start, "ddd한글 ", "the committed syllables and the space did not reach the region before Enter");

      await s.press("Enter");
      await typedUntil(s, surface, start, "ddd한글 \n", "Enter did not follow the committed command");

      // Syllables that are composed afterwards in the same session also reach the sidecar once each, in order.
      for (const key of ["g", "k", "s", "Space"]) await s.press(key);
      await preeditUntil(s, surface, (value) => value.text === "", "the second syllable left a preedit");
      await s.press("Enter");
      await typedUntil(s, surface, start, "한 \n", "the second committed syllable did not reach the region");

      // F8-16-1: A digit after a syllable also reaches the sidecar without a following key.
      for (const key of ["g", "k", "s", "1"]) await s.press(key);
      await preeditUntil(s, surface, (value) => value.text === "", "the digit after a syllable left a preedit");
      await typedUntil(s, surface, start, "한1", "the digit after a syllable did not reach the region before any further key");
      await s.press("Enter");
      await typedUntil(s, surface, start, "한1\n", "Enter did not follow the digit");

      // F8-20: During composition, Backspace is handled by the input method, which edits the syllable (one syllable becomes another),
      // and only the final syllable reaches the sidecar.
      for (const key of ["g", "k", "s", "Backspace"]) await s.press(key);
      await preeditUntil(s, surface, (value) => value.text === "하", "Backspace did not edit the composition to 하");
      await s.press("Enter");
      await typedUntil(s, surface, start, "하\n", "the edited syllable did not reach the region");

      const log = await receivedAfter(s, surface, start, "the sidecar did not echo the input transactions");
      assertReceivedUnchanged(log, `${app.name} Korean input`);
      await nativeInputDelivered(s, surface, offsets, start, `${app.name} Korean input`);
      const inserts = insertedText(log);
      const preeditStates = log.map((entry) => entry.preedit.text);
      const composed = preeditStates.filter((text, index) => index === 0 || text !== preeditStates[index - 1]).filter((text) => text !== "");
      t.diagnostic(`${app.name}: native inserts ${JSON.stringify(inserts)}, preedit ${JSON.stringify(composed)}`);
      assert.equal(inserts, "ddd한글 한 한1하", "the native client did not commit each syllable exactly once in order");
      assert.ok(!JAMO.test(inserts), `uncommitted jamo was committed: ${JSON.stringify(inserts)}`);
      assert.deepEqual(composed.slice(0, 3), ["ㅎ", "하", "한"], "the first syllable did not compose in order");
      for (const [index, suffix] of [[3, "ㄱ"], [4, "그"], [5, "글"]]) {
        assert.ok([suffix, `한${suffix}`].includes(composed[index]),
          `the second syllable did not compose in order: ${JSON.stringify(composed.slice(0, 6))}`);
      }
      assert.ok(!log.some((entry) => entry.actions.some((action) => action.type === "key" && action.key === "Backspace")),
        "Backspace during a composition reached the region as a key");
      const enters = log.filter((entry) => entry.actions.some((action) =>
        (action.type === "key" && action.key === "Enter") ||
        (action.type === "command" && action.selector === "insertNewline:"))).map((entry) => entry.sequence);
      const lastInsert = log.filter((entry) => entry.actions.some((action) => action.type === "insert")).at(-1).sequence;
      assert.equal(enters.length, 4, "four Enter actions were not reported");
      assert.ok(enters[3] > lastInsert, "Enter was delivered before the committed text");
      t.diagnostic(`${app.name}: PASS ddd한글 after an input-source switch`);
    });

  test(`${app.name}: the preedit reports the selected end of Korean preedit`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { log: { ...NATIVE_INPUT_LOG }, reads: READS });
    const surface = await focusedRegion(s);
    const offsets = nativeInputStart(s);
    const start = await lastTransaction(s, surface);
    assert.equal((await s.request("diagnostics.input.source", { select: "latin" })).current, "latin");
    for (const key of "ddd") await s.press(key);
    await typedUntil(s, surface, start, "ddd", "ASCII input did not reach the region before Korean input");
    assert.equal((await s.request("diagnostics.input.source", { select: "korean" })).current, "korean");
    for (const key of ["g", "k", "s", "r", "m", "f", "d", "m", "s"]) await s.press(key);
    const compose = await preeditUntil(s, surface, (value) => value.text.endsWith("은") && value.selectedRange?.location === value.text.length,
      "Korean preedit did not reach its selected end");
    assert.match(compose.text, /^[가-힣]+$/, "the preedit contains input other than Hangul syllables");
    await s.press("Space");
    await preeditUntil(s, surface, (value) => value.text === "", "Space did not commit the preedit");
    await documentUntil(s, surface, start, "ddd한글은 ", "committed Korean text did not reach the region before another key");
    const log = await receivedAfter(s, surface, start, "the sidecar did not echo the input transactions");
    assertReceivedUnchanged(log, `${app.name} selected end`);
    await nativeInputDelivered(s, surface, offsets, start, `${app.name} selected end`);
    assert.equal(insertedText(log), "ddd한글은 ", "the native client did not commit the text once in order");
    t.diagnostic(`${app.name}: preedit ${compose.text} selected end ${JSON.stringify(compose.selectedRange)}`);
  });

  test(`${app.name}: eight Korean vowels and one Backspace retain an exact input trace`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { performanceTrace: true, log: { ...NATIVE_INPUT_LOG, call: "debug", lifecycle: "info" },
      reads: [...READS, "native.record.info"] });
    const surface = await focusedRegion(s);
    assert.equal((await s.request("diagnostics.input.source", { select: "korean" })).current, "korean", "the korean input source is not enabled");
    const keys = [...Array(8).fill("k"), "Backspace", "Space"];
    const documents = [...Array.from({ length: 8 }, (_, index) => "ㅏ".repeat(index + 1)), "ㅏ".repeat(7), `${"ㅏ".repeat(7)} `];
    await compareAppKitReference(s, keys, documents.at(-1), documents);
    await focusImageActive(s, surface);
    assert.equal((await s.request("diagnostics.input.source", { select: "korean" })).current, "korean");
    const offsets = nativeInputStart(s);
    const start = await lastTransaction(s, surface);
    // Each key leaves the document that the same-window AppKit reference held after the same key, and the region presents it.
    for (const [index, key] of keys.entries()) {
      await s.press(key);
      await documentUntil(s, surface, start, documents[index],
        `${key} (key ${index + 1}): the image region did not reach the same-window AppKit document ${JSON.stringify(documents[index])}`);
    }
    const log = await receivedAfter(s, surface, start, "the sidecar did not echo the input transactions");
    assertReceivedUnchanged(log, `${app.name} eight vowels`);
    await nativeInputDelivered(s, surface, offsets, start, `${app.name} eight vowels`);
    assert.equal(inputDocument(log), documents.at(-1));
    for (const [key, expected] of [["k", 8], ["Backspace", 1], ["Space", 1]]) {
      const receipts = log.filter((entry) => transactionMatchesKey(entry, key));
      assert.equal(receipts.length, expected, `the log has ${receipts.length} ${key} receipts, expected ${expected}: ${JSON.stringify(log)}`);
    }
    t.diagnostic(`${app.name}: transactions ${JSON.stringify(log)}`);
  });
}
