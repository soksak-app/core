// Approval-gated activation checks for the native input client lifecycle.
// This file is selected explicitly; it is not part of the default window checks.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../../fixture.mjs";
import { ensureTerminals, presentedScreen, readScreenUntil } from "../../terminal-screen.mjs";
import { assertInputTraceDelivery, inputTraceTransactions, terminalInputReceiptMatches,
  terminalLineBeforeCursor, visibleInputBeforeCursor } from "../terminal-ime-document.mjs";

const ABC = "com.apple.keylayout.ABC";
const KOREAN_2SET = "com.apple.inputmethod.Korean.2SetKorean";

async function focusedTerminal(s, surface) {
  await s.keepPointerOutside();
  const view = await s.rect("terminal.view", undefined, surface);
  const x = view.document.x + view.x + view.width / 2;
  const y = view.document.y + view.y + view.height / 2;
  await s.pointer(x, y, "move", { activate: true });
  await s.click(x, y);
  await s.run("terminal.focus", {}, surface);
  await s.until("host.window", (host) => host.active && host.key &&
    host.regions.some((region) => region.surface === surface && region.focused),
  "the terminal did not become the focused view of the active key window");
  await s.until("terminal.cursor", (cursor) => cursor.focused,
    "the terminal did not report native focus", { surface });
}

async function startInputTrace(s, surface) {
  await s.run("terminal.ime.trace", { action: "start" }, surface);
  let active = true;
  s.cleanup(async () => {
    if (active) await s.run("terminal.ime.trace", { action: "stop" }, surface);
  });
  return async () => {
    const trace = await s.run("terminal.ime.trace", { action: "stop" }, surface);
    active = false;
    assert.equal(trace.overflow, false, "the native input trace overflowed");
    assert.ok(trace.entries.length > 0, "the native input trace is empty");
    return trace.entries;
  };
}

async function compareAppKitReference(s, keys, expected) {
  const window = s.window;
  await s.request("diagnostics.input.reference", { window, action: "open" });
  s.cleanup(() => s.request("diagnostics.input.reference", { window, action: "close" }));
  await s.request("diagnostics.input.reference", { window, action: "focus" });
  for (const step of keys) {
    if (typeof step === "string") await s.press(step);
    else if (step.source) {
      assert.equal((await s.request("diagnostics.input.source", { select: step.source })).current, step.source);
    } else await s.press(step.key);
  }
  const reference = await s.request("diagnostics.input.reference", { window, action: "wait", document: expected });
  assert.equal(reference.document, expected, "the AppKit reference document differs from the expected text");
  assert.equal(reference.marked, null, "the AppKit reference still has marked text after the sequence");
  assert.deepEqual(reference.selected, { location: expected.length, length: 0 },
    "the AppKit reference selection is not at the expected document end");
  await s.request("diagnostics.input.reference", { window, action: "close" });
}

async function preserveInputSource(s) {
  const original = (await s.request("diagnostics.input.source")).current;
  s.cleanup(() => s.request("diagnostics.input.source", { select: original }));
}

function insertedText(entries) {
  const { native } = inputTraceTransactions(entries);
  return native.flatMap((entry) => entry.actions
    .filter((action) => action.type === "insert")
    .map((action) => action.text)).join("");
}

async function preserveGestureCapture(s, artifactDir, label) {
  const capture = await s.record();
  let result = null;
  let preserved = false;
  const persist = () => {
    if (preserved || !result) return;
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
      await fresh(s, { log: { input: "info" }, reads: ["native.input.key_down", "native.input.callback"] });
      const [terminal] = await ensureTerminals(s, 1);
      const surface = terminal.surface;
      await readScreenUntil(s, surface, (lines) => lines.some((line) => /[$%#>]$/.test(line)),
        "the shell prompt did not appear");
      await preserveInputSource(s);
      await focusedTerminal(s, surface);
      await compareAppKitReference(s, [
        { source: ABC }, { key: "d" }, { key: "d" }, { key: "d" }, { source: KOREAN_2SET },
        { key: "g" }, { key: "k" }, { key: "s" }, { key: "r" }, { key: "m" }, { key: "f" }, { key: "Space" },
      ], "ddd한글 ");
      await focusedTerminal(s, surface);
      const stopTrace = await startInputTrace(s, surface);

      assert.equal((await s.request("diagnostics.input.source", { select: ABC })).current, ABC);
      for (const key of ["d", "d", "d"]) await s.press(key);
      await readScreenUntil(s, surface, (lines) => lines.some((line) => line.endsWith("ddd")),
        "ABC input did not reach the terminal before Korean input");
      assert.equal((await s.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET);
      for (const key of ["g", "k", "s", "r", "m", "f", "Space"]) await s.press(key);
      await s.until("terminal.compose", (compose) => compose.text === "",
        "Space did not end the Korean composition", { surface });
      const lines = await readScreenUntil(s, surface,
        (rows) => rows.some((line) => line.endsWith("ddd한글")),
        "the committed ddd한글 text did not reach the PTY");
      assert.ok(!lines.some((line) => /[ㄱ-ㅣ]/.test(line)), "uncommitted jamo reached the PTY");
      const entries = await stopTrace();
      assert.equal(insertedText(entries), "ddd한글 ", "native inserts did not commit ddd한글 once in order");
      t.diagnostic(`${app.name}: F8-9 expected document ddd한글 and one committed trailing space`);
    });

  test(`${app.name}: F143 gksk resyllabifies to 하나`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s, { log: { input: "info" }, reads: ["native.input.key_down", "native.input.callback"] });
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    await readScreenUntil(s, surface, (lines) => lines.some((line) => /[$%#>]$/.test(line)),
      "the shell prompt did not appear");
    await preserveInputSource(s);
    await focusedTerminal(s, surface);
    assert.equal((await s.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET);
    await compareAppKitReference(s, ["g", "k", "s", "k", "Space", "Enter"], "하나 \n");
    await focusedTerminal(s, surface);
    assert.equal((await s.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET);
    const stopTrace = await startInputTrace(s, surface);
    assert.equal((await s.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET);
    for (const key of ["g", "k", "s", "k", "Space"]) await s.press(key);
    await s.until("terminal.compose", (compose) => compose.text === "",
      "Space did not end the Korean resyllabification", { surface });
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.endsWith("하나")),
      "the Korean 2-Set sequence gksk did not produce 하나");
    await s.press("Enter");
    const lines = await readScreenUntil(s, surface,
      (rows) => rows.some((line) => line.includes("하나: command not found")),
      "the shell did not receive the committed syllables 하나");
    assert.ok(!lines.some((line) => /[ㄱ-ㅣ]/.test(line)), "uncommitted jamo reached the PTY");
    const entries = await stopTrace();
    assert.equal(insertedText(entries), "하나 ", "native inserts did not commit 하나 once in order");
    t.diagnostic(`${app.name}: F143 expected document 하나 and one committed trailing space`);
  });

  for (let cycle = 1; cycle <= 10; cycle++) {
    const cycleLabel = String(cycle).padStart(2, "0");
    test(`${app.name}: F239-47-33 lifecycle cycle ${cycleLabel} closes and reopens the project after the approved IME gesture`,
      { timeout: 120000 }, async (t) => {
        const s = await open(t, app);
        await fresh(s, { log: { input: "info" }, reads: ["native.input.key_down", "native.input.callback"] });
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
        const [terminal] = await ensureTerminals(lifecycle, 1);
        const surface = terminal.surface;
        await readScreenUntil(lifecycle, surface, (lines) => lines.some((line) => /[$%#>]$/.test(line)),
          "the lifecycle shell prompt did not appear");
        await preserveInputSource(lifecycle);
        await focusedTerminal(lifecycle, surface);
        assert.equal((await lifecycle.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET);
        await compareAppKitReference(lifecycle, [...Array(8).fill("k"), "Backspace", "Space"], `${"ㅏ".repeat(7)} `);
        await focusedTerminal(lifecycle, surface);
        assert.equal((await lifecycle.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET);
        const baselineScreen = await presentedScreen(lifecycle, surface);
        const baselineCompose = await lifecycle.get("terminal.compose", surface);
        const baselineCursor = await lifecycle.get("terminal.cursor", surface);
        const promptText = terminalLineBeforeCursor(baselineScreen, baselineCursor,
          `${app.name} lifecycle baseline`);
        const prompt = { row: baselineCursor.row, col: 0, text: promptText };
        const artifactDir = join(s.app.configDir, "logs", "ime-lifecycle", app.name, cycleLabel);
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(join(artifactDir, "baseline.json"), JSON.stringify({
          screen: baselineScreen, compose: baselineCompose, cursor: baselineCursor, prompt,
        }, null, 2));
        const stopCapture = await preserveGestureCapture(lifecycle, artifactDir, "approved-eight-vowels-backspace-space");
        assert.equal((await lifecycle.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET);
        const stopTrace = await startInputTrace(lifecycle, surface);
        for (const key of Array(8).fill("k").concat("Backspace", "Space")) await lifecycle.press(key);
        await lifecycle.until("terminal.compose", (compose) => compose.text === "",
          `cycle ${cycleLabel}: Space did not finish composition`, { surface });
        const completedScreen = await presentedScreen(lifecycle, surface);
        const completedCompose = await lifecycle.get("terminal.compose", surface);
        const completedCursor = await lifecycle.get("terminal.cursor", surface);
        const actualDocument = visibleInputBeforeCursor(completedScreen, completedCursor, prompt,
          completedCompose.text, `${app.name} cycle ${cycleLabel} completed document`);
        const expectedDocument = `${"ㅏ".repeat(7)} `;
        writeFileSync(join(artifactDir, "completed-document.json"), JSON.stringify({
          expectedDocument, actualDocument, screen: completedScreen,
          compose: completedCompose, cursor: completedCursor,
        }, null, 2));
        assert.equal(actualDocument, expectedDocument,
          `cycle ${cycleLabel}: committed screen plus current marked buffer differs from AppKit`);
        const entries = await stopTrace();
        writeFileSync(join(artifactDir, "native-input-transactions.json"), JSON.stringify(entries, null, 2));
        const { native } = assertInputTraceDelivery(entries);
        for (const [key, expectedCount] of [["k", 8], ["Backspace", 1], ["Space", 1]]) {
          const receipts = native.filter((transaction) => terminalInputReceiptMatches(
            entries.filter((entry) => entry.cids?.[0] === transaction.cids[0]), key));
          assert.equal(receipts.length, expectedCount,
            `cycle ${cycleLabel}: the trace has ${receipts.length} ${key} receipts, expected ${expectedCount}`);
        }
        assert.ok(insertedText(entries).includes(" "),
          `cycle ${cycleLabel}: the trace did not record the committed Space`);
        await stopCapture();

        let currentSurface = surface;
        for (let pass = 1; pass <= 2; pass++) {
          await lifecycle.run("core.project.close", { id: opened.id });
          await lifecycle.until("host.windows", (windows) => windows.find((item) => item.window === lifecycle.window)?.project === null,
            `cycle ${cycleLabel}, pass ${pass}: the closed project remained shown`);
          await lifecycle.until("host.window", (host) => !host.regions.some((region) => region.surface === currentSurface),
            `cycle ${cycleLabel}, pass ${pass}: the terminal image region remained attached after project close`);
          assert.equal(await lifecycle.get("core.page.error"), null,
            `cycle ${cycleLabel}, pass ${pass}: project close reported an application error`);
          opened = await lifecycle.run("core.project.open", { root: projectRoot, color: "#7db4ff" });
          await lifecycle.until("core.project", (value) => value?.id === opened.id,
            `cycle ${cycleLabel}, pass ${pass}: the project did not reopen`);
          const [replacement] = await ensureTerminals(lifecycle, 1);
          currentSurface = replacement.surface;
          await lifecycle.until("core.surfaces", (surfaces) => surfaces.some((item) => item.surface === currentSurface && item.visible),
            `cycle ${cycleLabel}, pass ${pass}: the terminal view did not register after reopen`);
          await lifecycle.get("terminal.session", currentSurface);
          assert.equal(await lifecycle.get("core.page.error"), null,
            `cycle ${cycleLabel}, pass ${pass}: project reopen reported an application error`);
        }
        t.diagnostic(`${app.name}: F239-47-33 cycle ${cycleLabel}/10 completed two project close/reopen passes`);
      });
  }
}
