// Approval-gated activation checks for the native input client lifecycle.
// This file is selected explicitly; it is not part of the default window checks.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../../fixture.mjs";
import { ensureTerminals, readScreenUntil } from "../../terminal-screen.mjs";

const ABC = "com.apple.keylayout.ABC";
const KOREAN_2SET = "com.apple.inputmethod.Korean.2SetKorean";

async function focusedTerminal(s, surface) {
  await s.keepPointerOutside();
  const view = await s.rect("terminal.view", undefined, surface);
  const x = view.document.x + view.x + view.width / 2;
  const y = view.document.y + view.y + view.height / 2;
  await s.pointer(x, y, "move", { activate: true });
  await s.click(x, y);
  await s.until("host.window", (host) => host.active && host.key &&
    host.regions.some((region) => region.surface === surface && region.focused),
  "the terminal did not become the focused view of the active key window");
  await s.run("terminal.focus", {}, surface);
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
  return entries.flatMap((entry) => entry.actions
    .filter((action) => action.type === "insert")
    .map((action) => action.text)).join("");
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
    await compareAppKitReference(s, ["g", "k", "s", "k", "Space"], "하나 ");
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
        s.cleanup(() => rmSync(projectRoot, { recursive: true, force: true }));
        const opened = await s.run("core.project.open", { root: projectRoot, color: "#7db4ff" });
        s.cleanup(async () => {
          const projects = await s.get("core.projects");
          if (projects.some((item) => item.id === opened.id)) await s.run("core.project.close", { id: opened.id });
        });
        await s.until("core.project", (value) => value?.id === opened.id,
          "the lifecycle project did not become current");
        const [terminal] = await ensureTerminals(s, 1);
        const surface = terminal.surface;
        await readScreenUntil(s, surface, (lines) => lines.some((line) => /[$%#>]$/.test(line)),
          "the lifecycle shell prompt did not appear");
        await preserveInputSource(s);
        await focusedTerminal(s, surface);
        assert.equal((await s.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET);
        await compareAppKitReference(s, [...Array(8).fill("k"), "Backspace", "Space"], `${"ㅏ".repeat(7)} `);
        await focusedTerminal(s, surface);
        assert.equal((await s.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET);
        const stopTrace = await startInputTrace(s, surface);
        assert.equal((await s.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET);

        for (let index = 1; index <= 8; index++) {
          await s.press("k");
          await s.until("terminal.compose", (compose) => compose.text.length >= index,
            `cycle ${cycleLabel}: vowel ${index} did not update composition`, { surface });
        }
        await s.press("Backspace");
        await s.until("terminal.compose", (compose) => compose.text.length === 7,
          `cycle ${cycleLabel}: Backspace did not leave seven vowels`, { surface });
        await s.press("Space");
        await s.until("terminal.compose", (compose) => compose.text === "",
          `cycle ${cycleLabel}: Space did not finish composition`, { surface });
        await readScreenUntil(s, surface, (lines) => lines.some((line) => line.includes("ㅏ".repeat(7))),
          `cycle ${cycleLabel}: committed vowels did not reach the PTY`);
        const entries = await stopTrace();
        assert.ok(insertedText(entries).includes("ㅏ".repeat(7)),
          `cycle ${cycleLabel}: the native input trace did not preserve the seven committed vowels`);

        const oldProjectId = opened.id;
        await s.run("core.project.close", { id: oldProjectId });
        await s.until("host.windows", (windows) => windows.find((item) => item.window === s.window)?.project === null,
          `cycle ${cycleLabel}: the closed project remained shown`);
        await s.until("host.window", (host) => !host.regions.some((region) => region.surface === surface),
          `cycle ${cycleLabel}: the terminal image region remained attached after project close`);
        assert.equal(await s.get("core.page.error"), null,
          `cycle ${cycleLabel}: project close reported an application error`);

        const reopened = await s.run("core.project.open", { root: projectRoot, color: "#7db4ff" });
        await s.until("core.project", (value) => value?.id === reopened.id,
          `cycle ${cycleLabel}: the project did not reopen`);
        const [replacement] = await ensureTerminals(s, 1);
        await s.until("core.surfaces", (surfaces) => surfaces.some((item) => item.surface === replacement.surface && item.visible),
          `cycle ${cycleLabel}: the terminal view did not register after reopen`);
        await s.get("terminal.session", replacement.surface);
        assert.equal(await s.get("core.page.error"), null,
          `cycle ${cycleLabel}: project reopen reported an application error`);
        t.diagnostic(`${app.name}: F239-47-33 cycle ${cycleLabel}/10 closed the old image region and reopened a terminal`);
      });
  }
}
