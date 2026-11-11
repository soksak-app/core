// Approval-gated activation checks for the native input client lifecycle. The image region of the raster probe carries the native
// input client of core, and `rasterprobe.input` logs each input transaction with the echo of its sidecar and the frame that the
// sidecar drew after it: each check waits until the region presents the frame of each stage that it waits for, and checks that each
// native input transaction that the event log records reaches the sidecar unchanged under its correlation identifiers.
// This file is selected explicitly; it is not part of the default window checks.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { frames, readFrame } from "@soksak/window-check/frame.mjs";
import { fresh } from "../../fixture.mjs";
import { compareAppKitReference } from "../ime-reference-steps.mjs";
import { assertReceivedUnchanged, focusedCard, imageRegion, inputDocument, insertedText, lastTransaction,
  presentedStage, rasterProbeTab, receivedAfter, transactionMatchesKey, untilDocument } from "../../input-probe.mjs";
import { focusImageActive } from "../image-focus.mjs";
import { NATIVE_INPUT_LOG, NATIVE_INPUT_READS, nativeInputDelivered, nativeInputStart } from "../../native-input-trace.mjs";

/** The log policy and the records of the checks of this file: the input records of the native library and the sidecar requests. */
const READS = ["native.input.key_down", "native.input.callback", ...NATIVE_INPUT_READS];


async function preserveInputSource(s) {
  const original = (await s.request("diagnostics.input.source")).source;
  s.cleanup(() => s.request("diagnostics.input.source", { restore: original }));
}

async function preserveGestureCapture(s, artifactDir, label) {
  const capture = await s.record();
  let result = null;
  let preserved = false;
  const persist = () => {
    if (preserved || !result) return;
    const recordedFrames = frames(capture.frames);
    assert.equal(recordedFrames.length, result.count, `${label}: capture frame files are missing`);
    for (const file of recordedFrames) readFrame(file);
    const destination = join(artifactDir, label);
    cpSync(capture.frames, destination, { recursive: true });
    writeFileSync(join(artifactDir, `${label}.json`), JSON.stringify({
      ...result,
      frames: destination,
      sourceFrames: capture.frames,
      frameCount: result.count,
    }, null, 2));
    preserved = true;
  };
  s.cleanup(async () => {
    if (!result) result = await capture.stop({ after: 0 });
    persist();
  });
  return async () => {
    const { displayed } = await s.presented();
    result = await capture.stop({ after: displayed + 100 });
    assert.ok(result.count > 0, `${label}: the full-gesture capture contains no frames`);
    assert.equal(result.limited, false, `${label}: the full-gesture capture reached its frame limit`);
    persist();
    return result;
  };
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: F8-9 ddd and Korean 2-Set sequence commits 한글 once`,
    { timeout: 60000 }, async (t) => {
      const s = await open(t, app);
      await fresh(s, { log: { ...NATIVE_INPUT_LOG }, reads: READS });
      const { surface } = await rasterProbeTab(s);
      await preserveInputSource(s);
      await focusImageActive(s, surface);
      await compareAppKitReference(s, [
        { source: "latin" }, { key: "d" }, { key: "d" }, { key: "d" }, { source: "korean" },
        { key: "g" }, { key: "k" }, { key: "s" }, { key: "r" }, { key: "m" }, { key: "f" }, { key: "Space" },
      ], "ddd한글 ", ["", "d", "dd", "ddd", "ddd", "dddㅎ", "ddd하", "ddd한", "ddd한ㄱ", "ddd한그", "ddd한글", "ddd한글 "]);
      await focusImageActive(s, surface);
      const offsets = nativeInputStart(s);
      const start = await lastTransaction(s, surface);

      assert.equal((await s.request("diagnostics.input.source", { select: "latin" })).current, "latin");
      for (const key of ["d", "d", "d"]) await s.press(key);
      await untilDocument(s, surface, start, "ddd", "latin input did not reach the region before Korean input");
      await presentedStage(s, surface, "the latin input ddd");
      assert.equal((await s.request("diagnostics.input.source", { select: "korean" })).current, "korean");
      for (const key of ["g", "k", "s", "r", "m", "f", "Space"]) await s.press(key);
      await s.until("rasterprobe.input", (input) => input.preedit?.text === "", "Space did not end the Korean composition", { surface });
      await untilDocument(s, surface, start, "ddd한글 ", "the committed ddd한글 text did not reach the region");
      await presentedStage(s, surface, "the committed ddd한글 text");
      const entries = await receivedAfter(s, surface, start, "the sidecar did not echo the input transactions");
      assertReceivedUnchanged(entries, `${app.name} F8-9`);
      await nativeInputDelivered(s, surface, offsets, start, `${app.name} F8-9`);
      assert.ok(!/[ㄱ-ㅣ]/.test(insertedText(entries)), "uncommitted jamo was committed");
      assert.equal(insertedText(entries), "ddd한글 ", "native inserts did not commit ddd한글 once in order");
      t.diagnostic(`${app.name}: F8-9 expected document ddd한글 and one committed trailing space`);
    });

  test(`${app.name}: F143 gksk resyllabifies to 하나`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { log: { ...NATIVE_INPUT_LOG }, reads: READS });
    const { surface } = await rasterProbeTab(s);
    await preserveInputSource(s);
    await focusImageActive(s, surface);
    assert.equal((await s.request("diagnostics.input.source", { select: "korean" })).current, "korean");
    await compareAppKitReference(s, ["g", "k", "s", "k", "Space", "Enter"], "하나 \n", ["ㅎ", "하", "한", "하나", "하나 ", "하나 \n"]);
    await focusImageActive(s, surface);
    assert.equal((await s.request("diagnostics.input.source", { select: "korean" })).current, "korean");
    const offsets = nativeInputStart(s);
    const start = await lastTransaction(s, surface);
    for (const key of ["g", "k", "s", "k", "Space"]) await s.press(key);
    await s.until("rasterprobe.input", (input) => input.preedit?.text === "", "Space did not end the Korean resyllabification", { surface });
    await untilDocument(s, surface, start, "하나 ", "the Korean 2-Set sequence gksk did not produce 하나");
    await presentedStage(s, surface, "the committed syllables 하나");
    await s.press("Enter");
    await untilDocument(s, surface, start, "하나 \n", "the region did not receive Enter after the committed syllables 하나");
    await presentedStage(s, surface, "Enter after 하나");
    const entries = await receivedAfter(s, surface, start, "the sidecar did not echo the input transactions");
    assertReceivedUnchanged(entries, `${app.name} F143`);
    await nativeInputDelivered(s, surface, offsets, start, `${app.name} F143`);
    assert.ok(!/[ㄱ-ㅣ]/.test(insertedText(entries)), "uncommitted jamo was committed");
    assert.equal(insertedText(entries), "하나 ", "native inserts did not commit 하나 once in order");
    t.diagnostic(`${app.name}: F143 expected document 하나 and one committed trailing space`);
  });

  for (let cycle = 1; cycle <= 10; cycle++) {
    const cycleLabel = String(cycle).padStart(2, "0");
    test(`${app.name}: F239-47-33 lifecycle cycle ${cycleLabel} closes and reopens the project after the approved IME gesture`,
      { timeout: 120000 }, async (t) => {
        const s = await open(t, app);
        await fresh(s, { log: { ...NATIVE_INPUT_LOG }, reads: READS });
        const projectRoot = mkdtempSync(join(tmpdir(), "soksak-ime-lifecycle-"));
        const canonicalProjectRoot = realpathSync(projectRoot);
        s.cleanup(() => rmSync(projectRoot, { recursive: true, force: true }));
        const existingWindows = await s.get("host.windows");
        await s.run("core.window.new");
        const windows = await s.until("host.windows", (windows) => {
          const added = windows.filter((item) => !existingWindows.some((previous) => previous.window === item.window));
          return windows.length === existingWindows.length + 1 && added.length === 1 && windows.every((item) => item.ready);
        }, "the lifecycle project window did not open");
        const addedWindows = windows.filter((item) => !existingWindows.some((previous) => previous.window === item.window));
        assert.equal(addedWindows.length, 1, "opening the lifecycle window did not add exactly one window");
        assert.equal(typeof addedWindows[0].window, "string", "the lifecycle window ID is not a string");
        const lifecycle = s.on(addedWindows[0].window);
        await lifecycle.until("core.project", (value) => value === null,
          "the lifecycle project window was not unassigned");
        s.cleanup(async () => {
          if ((await s.get("host.windows")).some((item) => item.window === lifecycle.window)) await lifecycle.close();
          await s.windows(existingWindows.length, "the lifecycle project window did not close");
        });
        let opened = null;
        s.cleanup(async () => {
          const projects = await s.get("core.projects");
          for (const project of projects.filter((item) => item.root === canonicalProjectRoot)) {
            await lifecycle.run("core.project.close", { id: project.id });
          }
        });
        opened = await lifecycle.run("core.project.open", { root: projectRoot, color: "#7db4ff" });
        await lifecycle.until("core.project", (value) => value?.id === opened.id,
          "the lifecycle project did not become current");
        const { surface } = await rasterProbeTab(lifecycle, { card: focusedCard(await lifecycle.get("core.grid")).id });
        await preserveInputSource(lifecycle);
        await focusImageActive(lifecycle, surface);
        assert.equal((await lifecycle.request("diagnostics.input.source", { select: "korean" })).current, "korean");
        const keys = [...Array(8).fill("k"), "Backspace", "Space"];
        const documents = [...Array.from({ length: 8 }, (_, index) => "ㅏ".repeat(index + 1)), "ㅏ".repeat(7), `${"ㅏ".repeat(7)} `];
        await compareAppKitReference(lifecycle, keys, documents.at(-1), documents);
        await focusImageActive(lifecycle, surface);
        assert.equal((await lifecycle.request("diagnostics.input.source", { select: "korean" })).current, "korean");
        const artifactRoot = join(s.app.configDir, "logs", "ime-lifecycle", app.name);
        mkdirSync(artifactRoot, { recursive: true });
        const artifactDir = mkdtempSync(join(artifactRoot, `${cycleLabel}-`));
        t.diagnostic(`lifecycle observations: ${artifactDir}`);
        const stopCapture = await preserveGestureCapture(lifecycle, artifactDir, "approved-eight-vowels-backspace-space");
        assert.equal((await lifecycle.request("diagnostics.input.source", { select: "korean" })).current, "korean");
        const offsets = nativeInputStart(lifecycle);
        const start = await lastTransaction(lifecycle, surface);
        for (const key of keys) await lifecycle.press(key);
        const expectedDocument = documents.at(-1);
        await untilDocument(lifecycle, surface, start, expectedDocument,
          `cycle ${cycleLabel}: the committed text plus the current marked text differs from AppKit`);
        await presentedStage(lifecycle, surface, `cycle ${cycleLabel}: the completed document`);
        const entries = await receivedAfter(lifecycle, surface, start, `cycle ${cycleLabel}: the sidecar did not echo the input`);
        writeFileSync(join(artifactDir, "native-input-transactions.json"), JSON.stringify(entries, null, 2));
        assertReceivedUnchanged(entries, `cycle ${cycleLabel}`);
        await nativeInputDelivered(lifecycle, surface, offsets, start, `cycle ${cycleLabel}`);
        assert.equal(inputDocument(entries), expectedDocument, `cycle ${cycleLabel}: the region document differs from AppKit`);
        for (const [key, expectedCount] of [["k", 8], ["Backspace", 1], ["Space", 1]]) {
          const receipts = entries.filter((transaction) => transactionMatchesKey(transaction, key));
          assert.equal(receipts.length, expectedCount,
            `cycle ${cycleLabel}: the log has ${receipts.length} ${key} receipts, expected ${expectedCount}`);
        }
        assert.ok(insertedText(entries).includes(" "), `cycle ${cycleLabel}: the log did not record the committed Space`);
        await stopCapture();

        let currentSurface = surface;
        for (let pass = 1; pass <= 2; pass++) {
          await lifecycle.run("core.project.close", { id: opened.id });
          await lifecycle.until("host.windows", (windows) => windows.find((item) => item.window === lifecycle.window)?.project === null,
            `cycle ${cycleLabel}, pass ${pass}: the closed project remained shown`);
          await lifecycle.until("host.window", (host) => imageRegion(host, currentSurface) === undefined,
            `cycle ${cycleLabel}, pass ${pass}: the image region remained attached after project close`);
          assert.equal(await lifecycle.get("core.workbench.error"), null,
            `cycle ${cycleLabel}, pass ${pass}: project close reported an application error`);
          opened = await lifecycle.run("core.project.open", { root: projectRoot, color: "#7db4ff" });
          await lifecycle.until("core.project", (value) => value?.id === opened.id,
            `cycle ${cycleLabel}, pass ${pass}: the project did not reopen`);
          const grid = await lifecycle.until("core.grid", (value) => value?.cards?.some((card) => !card.fixed && card.tabs?.length),
            `cycle ${cycleLabel}, pass ${pass}: the reopened project has no card with tabs`);
          const replacement = await rasterProbeTab(lifecycle, { card: focusedCard(grid).id });
          currentSurface = replacement.surface;
          await lifecycle.until("core.surfaces", (surfaces) => surfaces.some((item) => item.surface === currentSurface && item.visible),
            `cycle ${cycleLabel}, pass ${pass}: the raster probe view did not register after reopen`);
          await lifecycle.get("rasterprobe.session", currentSurface);
          assert.equal(await lifecycle.get("core.workbench.error"), null,
            `cycle ${cycleLabel}, pass ${pass}: project reopen reported an application error`);
        }
        t.diagnostic(`${app.name}: F239-47-33 cycle ${cycleLabel}/10 completed two project close/reopen passes`);
      });
  }
}
