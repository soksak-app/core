// Activation-tier window check: types Hangul into the terminal through the real macOS input method.
//
// The OS input method serves only the key window of the active application, so this check activates the app and takes the user's focus,
// and switches the input source through diagnostics.input.source of the diagnostic build. At the end it restores the previous input source.
// It is not part of the default window check (pnpm -F @soksak/e2e verify); a run that the user approved runs it
// only through pnpm -F @soksak/e2e verify:activation.
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";
import { ensureTerminals, presentedScreen, readScreenUntil, textLines } from "../terminal-screen.mjs";
import { capturesByInputStage, evaluateVisualStages, hostClockBoundary, indexFrameStatus, persistThenRequireVisualProof,
  planVisualStage, readRetainedSources }
  from "./ime-visual-capture.mjs";
import {
  assertTerminalStageCoherent,
  sameTerminalComposition,
  startTerminalStatusObserver,
  terminalComposeMatchesPreedit,
  terminalCompositionState,
  terminalInputReceiptMatches,
  terminalObserverStatusesMatch,
  terminalLineBeforeCursor,
  selectCoherentTerminalObservation,
  visibleInputBeforeCursor,
  waitForObservedStatusEvent,
  waitForStateEvent as waitForStateEventAfter,
  waitForTerminalStage,
} from "./terminal-ime-document.mjs";

const ABC = "com.apple.keylayout.ABC";
const KOREAN_2SET = "com.apple.inputmethod.Korean.2SetKorean";

async function machAbsoluteBoundary(s) {
  return hostClockBoundary((method, params) => s.request(method, params));
}

function assertReferenceRanges(state, label) {
  assert.equal(typeof state.document, "string", `${label}: reference document is not text`);
  const validRange = (range) => range && Number.isInteger(range.location) && range.location >= 0
    && Number.isInteger(range.length) && range.length >= 0
    && range.location + range.length <= state.document.length;
  assert.ok(validRange(state.selected), `${label}: selected range is outside the document`);
  assert.ok(state.marked === null || validRange(state.marked), `${label}: marked range is outside the document`);
}

// Measures the ratio of pixels that differ from the surface background in the cursor cell and the cell to its right. The capture does not bring the window to the front.
async function cursorCellCoverage(s, surface, offset = 0, preedit = null) {
  // terminal.compose is the state of the page; the service draws the preedit when its compose arrives, and terminal.cursor
  // carries the preedit that the service drew, so a measurement of a preedit first waits for it.
  if (preedit !== null) {
    await s.until("terminal.cursor", (cursor) => cursor?.preedit?.text === preedit,
      `the service did not draw the preedit ${JSON.stringify(preedit)}`, { surface });
  }
  // The screen read carries the current cursor into terminal.cursor, and the pixels are read after the frame of that screen
  // is presented.
  await presentedScreen(s, surface);
  await s.request("diagnostics.capture.start", {});
  const displayed = await s.presented();
  const { frames: frameDir } = await s.request("diagnostics.capture.stop", { after: displayed.displayed });
  try {
    const files = frames(frameDir);
    assert.ok(files.length > 0, "the cursor capture produced no frames");
    const frame = readFrame(files.at(-1));
    const region = (await s.get("host.window")).regions.find((item) => item.surface === surface && item.name === "view");
    assert.ok(region?.frame, `native terminal region ${surface} has no frame`);
    const cursor = await s.get("terminal.cursor", surface);
    const state = await s.get("terminal.session", surface);
    const background = pixel(frame, Math.round((region.frame.x + region.frame.width - 2) * frame.scale),
      Math.round((region.frame.y + region.frame.height - 2) * frame.scale));
    const coverage = (col) => {
      const x0 = Math.round((region.frame.x + col * state.cellWidth) * frame.scale);
      const y0 = Math.round((region.frame.y + cursor.row * state.cellHeight) * frame.scale);
      const x1 = x0 + Math.floor(state.cellWidth * frame.scale);
      const y1 = y0 + Math.floor(state.cellHeight * frame.scale);
      let different = 0;
      let total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const value = pixel(frame, x, y);
          total++;
          if (value.some((channel, index) => Math.abs(channel - background[index]) > 60)) different++;
        }
      }
      return different / total;
    };
    // The glyph stroke under a block cursor is inverted and dark. The ratio of dark pixels in the second cell is the ink of the right half of the glyph.
    const darkInCell = (col) => {
      const x0 = Math.round((region.frame.x + col * state.cellWidth) * frame.scale);
      const y0 = Math.round((region.frame.y + cursor.row * state.cellHeight) * frame.scale);
      let dark = 0;
      let total = 0;
      for (let y = y0; y < y0 + Math.floor(state.cellHeight * frame.scale); y++) {
        for (let x = x0; x < x0 + Math.floor(state.cellWidth * frame.scale); x++) {
          const [r, g, b] = pixel(frame, x, y);
          total++;
          if (0.299 * r + 0.587 * g + 0.114 * b < 100) dark++;
        }
      }
      return dark / total;
    };
    return {
      cursor,
      first: coverage(cursor.col + offset),
      second: coverage(cursor.col + offset + 1),
      preeditSecond: coverage(cursor.col + Math.max(offset - 1, 1)),
      secondInk: darkInCell(cursor.col + Math.max(offset - 1, 1)),
    };
  } finally {
    rmSync(frameDir, { recursive: true, force: true });
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a Korean syllable typed right after an input-source switch reaches the PTY once`,
    { timeout: 60000 }, async (t) => {
      const s = await open(t, app);
      await fresh(s);
      const [terminal] = await ensureTerminals(s, 1);
      const surface = terminal.surface;
      await readScreenUntil(s, surface, (lines) => lines.some((line) => /[$%#>]$/.test(line)),
        "the shell prompt did not appear");

      const original = (await s.request("diagnostics.input.source")).current;
      s.cleanup(() => s.request("diagnostics.input.source", { select: original }));

      // The key window receives the pointer position as a movement, so the window is placed away from the pointer.
      await s.keepPointerOutside();
      const view = await s.rect("terminal.view", undefined, surface);
      const x = view.document.x + view.x + view.width / 2;
      const y = view.document.y + view.y + view.height / 2;
      await s.pointer(x, y, "move", { activate: true });
      await s.click(x, y);
      await s.until("host.window", (host) => host.active === true &&
        host.regions.some((region) => region.surface === surface && region.focused),
      "the terminal did not receive native focus in the active window");

      // Records the native callbacks and the PTY input queue. The results are checked below by order and count.
      await s.run("terminal.ime.trace", { action: "start" }, surface);
      s.cleanup(() => s.run("terminal.ime.trace", { action: "stop" }, surface));

      // Order from the user report: ddd with the English layout, then Hangul with the Korean 2-set layout (g k s r m f), Space, Enter.
      assert.equal((await s.request("diagnostics.input.source", { select: ABC })).current, ABC);
      for (const typed of ["d", "dd", "ddd"]) {
        await s.press("d");
        await readScreenUntil(s, surface, (lines) => lines.some((line) => line.endsWith(typed)),
          `the ABC key did not produce ${typed}`);
      }
      // In the empty cell after a narrow glyph, the cursor covers only one cell.
      const narrow = await cursorCellCoverage(s, surface);
      t.diagnostic(`${app.name}: narrow cursor coverage ${JSON.stringify({ col: narrow.cursor.col, first: narrow.first, second: narrow.second })}`);
      assert.ok(narrow.first > 0.9 && narrow.second < 0.1,
        `the cursor after ASCII text must cover exactly one cell: ${JSON.stringify(narrow)}`);
      assert.equal((await s.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET);

      const steps = [["g", "ㅎ"], ["k", "하"], ["s", "한"], ["r", "ㄱ"], ["m", "그"], ["f", "글"]];
      let preeditCursor;
      let preeditWidth;
      for (const [key, preedit] of steps) {
        await s.press(key);
        const compose = await s.until("terminal.compose", (value) => value.text === preedit ||
          (value.text === `한${preedit}` && ["ㄱ", "그", "글"].includes(preedit)),
          `the ${key} key did not show the ${JSON.stringify(preedit)} preedit`, { surface });
        if (preedit === "글") {
          // The selection range points after the text, so the cursor is drawn in the cell after the composed glyph.
          assert.equal(compose.selectedRange?.location, compose.text.length,
            "the input method did not select the end of the preedit");
          preeditWidth = compose.text.length * 2;
          const measured = await cursorCellCoverage(s, surface, preeditWidth, compose.text);
          preeditCursor = measured.cursor;
          t.diagnostic(`${app.name}: preedit 글 cursor coverage ${JSON.stringify(measured)}`);
          assert.ok(measured.first > 0.9 && measured.second < 0.1,
            `the block cursor is not after the wide preedit: ${JSON.stringify(measured)}`);
          // The right half of a wide composed glyph is drawn as well.
          assert.ok(measured.preeditSecond > 0.02,
            `the right half of the wide preedit glyph is missing: ${JSON.stringify(measured)}`);
        }
      }
      // F8-16: Space is a key that the input method does not handle, so the text and the space reach the PTY without a following key.
      // When the shell echoes the remaining composition string and the space, the cursor moves by their display width.
      await s.press("Space");
      await s.until("terminal.compose", (compose) => compose.text === "",
        "the Space key left a preedit", { surface });
      const spaced = await s.until("terminal.cursor", (cursor) => cursor.row === preeditCursor.row &&
        cursor.col === preeditCursor.col + preeditWidth + 1,
        `the space after 글 did not reach the PTY before any further key (preedit cursor ${JSON.stringify(preeditCursor)})`, { surface });
      t.diagnostic(`${app.name}: cursor after Space ${JSON.stringify(spaced)} from preedit cursor ${JSON.stringify(preeditCursor)}`);
      const typed = await readScreenUntil(s, surface, (lines) => lines.some((line) => line.trimEnd().endsWith("ddd한글")),
        "the committed syllables did not reach the PTY before Enter");
      assert.ok(!typed.some((line) => /[ㄱ-ㅣ]/.test(line)),
        `uncommitted jamo reached the PTY: ${JSON.stringify(typed)}`);

      await s.press("Enter");
      await s.until("terminal.compose", (compose) => compose.text === "",
        "Enter did not end the preedit", { surface });
      const output = await readScreenUntil(s, surface,
        (lines) => lines.some((line) => /not found/.test(line) && line.includes("ddd한글")),
        "the shell did not run the committed command");
      const commandRows = output.filter((line) => line.includes("ddd한글"));
      assert.ok(commandRows.every((line) => line.split("ddd한글").length === 2),
        `the committed text was repeated: ${JSON.stringify(commandRows)}`);
      assert.ok(!output.some((line) => /[ㄱ-ㅣ]/.test(line)), `jamo reached the PTY: ${JSON.stringify(output)}`);
      t.diagnostic(`${app.name}: screen rows with the command: ${JSON.stringify(commandRows)}`);

      // Syllables that are composed afterwards in the same session also reach the PTY once each, in order.
      for (const key of ["g", "k", "s", "Space"]) await s.press(key);
      await s.until("terminal.compose", (compose) => compose.text === "", "the second syllable left a preedit", { surface });
      await s.press("Enter");
      const second = await readScreenUntil(s, surface, (lines) => lines.some((line) => /한: command not found/.test(line)),
        "the shell did not run the second committed command");
      assert.ok(!second.some((line) => /[ㄱ-ㅣ]/.test(line)), `jamo reached the PTY: ${JSON.stringify(second)}`);

      // F8-16-1: A digit after a syllable also reaches the PTY without a following key.
      for (const key of ["g", "k", "s", "1"]) await s.press(key);
      await s.until("terminal.compose", (compose) => compose.text === "", "the digit after a syllable left a preedit", { surface });
      await readScreenUntil(s, surface, (lines) => lines.some((line) => line.trimEnd().endsWith("한1")),
        "the digit after a syllable did not reach the PTY before any further key");
      await s.press("Enter");
      await readScreenUntil(s, surface, (lines) => lines.some((line) => /한1: command not found/.test(line)),
        "the shell did not run the command with the digit");

      // F8-20: During composition, Backspace is handled by the input method, which edits the syllable (one syllable becomes another), and only the final syllable reaches the PTY.
      for (const key of ["g", "k", "s", "Backspace"]) await s.press(key);
      await s.until("terminal.compose", (compose) => compose.text === "하", "Backspace did not edit the composition to 하", { surface });
      await s.press("Enter");
      try {
        await readScreenUntil(s, surface, (lines) => lines.some((line) => /하: command not found/.test(line)),
          "the shell did not run the edited syllable");
      } catch (error) {
        const trace = await s.run("terminal.ime.trace", { action: "stop" }, surface);
        error.message += `; input trace ${JSON.stringify(trace.entries)}`;
        throw error;
      }

      const trace = await s.run("terminal.ime.trace", { action: "stop" }, surface);
      assert.equal(trace.overflow, false, "the IME trace overflowed");
      const inserts = trace.entries.filter((entry) => entry.kind === "native-insert").map((entry) => entry.text).join("");
      const written = trace.entries.filter((entry) => entry.kind === "terminal-input" && entry.input.type === "insert")
        .map((entry) => entry.input.text).join("");
      const composed = trace.entries.filter((entry) => entry.kind === "native-compose" && entry.text !== "").map((entry) => entry.text);
      t.diagnostic(`${app.name}: native inserts ${JSON.stringify(inserts)}, terminal inserts ${JSON.stringify(written)}, preedit ${JSON.stringify(composed)}`);
      assert.equal(inserts, "ddd한글 한 한1하", "the native client did not commit each syllable exactly once in order");
      assert.equal(written, "ddd한글 한 한1하", "the terminal input queue did not receive each committed syllable exactly once in order");
      assert.deepEqual(composed.slice(0, 3), ["ㅎ", "하", "한"], "the first syllable did not compose in order");
      for (const [index, suffix] of [[3, "ㄱ"], [4, "그"], [5, "글"]]) {
        assert.ok([suffix, `한${suffix}`].includes(composed[index]),
          `the second syllable did not compose in order: ${JSON.stringify(composed.slice(0, 6))}`);
      }
      assert.ok(!trace.entries.some((entry) => entry.kind === "native-key" && entry.key === "Backspace"),
        "Backspace during a composition reached the terminal as a key");
      const enters = trace.entries.filter((entry) =>
        (entry.kind === "native-key" && entry.key === "Enter") ||
        (entry.kind === "terminal-input" && entry.input?.type === "command" && entry.input.selector === "insertNewline:"))
        .map((entry) => entry.sequence);
      const lastInsert = trace.entries.filter((entry) => entry.kind === "native-insert").at(-1).sequence;
      assert.equal(enters.length, 4, "four Enter actions were not traced");
      assert.ok(enters[3] > lastInsert, "Enter was delivered before the committed text");
      t.diagnostic(`${app.name}: PASS ddd한글 after an input-source switch`);
    });

  test(`${app.name}: the cursor follows the selected end of Korean preedit`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    const original = (await s.request("diagnostics.input.source")).current;
    s.cleanup(() => s.request("diagnostics.input.source", { select: original }));
    await s.keepPointerOutside();
    const view = await s.rect("terminal.view", undefined, surface);
    const x = view.document.x + view.x + view.width / 2;
    const y = view.document.y + view.y + view.height / 2;
    await s.pointer(x, y, "move", { activate: true });
    await s.click(x, y);
    await s.until("host.window", (host) => host.active === true &&
      host.regions.some((region) => region.surface === surface && region.focused),
    "the terminal did not receive native focus in the active window");
    assert.equal((await s.request("diagnostics.input.source", { select: ABC })).current, ABC);
    for (const key of "ddd") await s.press(key);
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.endsWith("ddd")),
      "ASCII input did not reach the PTY before Korean input");
    assert.equal((await s.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET);
    await s.run("terminal.ime.trace", { action: "start" }, surface);
    s.cleanup(() => s.run("terminal.ime.trace", { action: "stop" }, surface));
    for (const key of ["g", "k", "s", "r", "m", "f", "d", "m", "s"]) await s.press(key);
    const compose = await s.until("terminal.compose", (value) => value.text.endsWith("은") &&
      value.selectedRange?.location === value.text.length,
    "Korean preedit did not reach its selected end", { surface });
    assert.match(compose.text, /^[가-힣]+$/, "the preedit contains input other than Hangul syllables");
    const measured = await cursorCellCoverage(s, surface, compose.text.length * 2, compose.text);
    t.diagnostic(`${app.name}: preedit ${compose.text} selected end coverage ${JSON.stringify(measured)}`);
    assert.ok(measured.first > 0.9 && measured.second < 0.1,
      `the cursor is not after the selected Korean preedit: ${JSON.stringify(measured)}`);
    await s.press("Space");
    try {
      await s.until("terminal.compose", (value) => value.text === "", "Space did not commit the preedit", { surface });
    } catch (error) {
      const trace = await s.run("terminal.ime.trace", { action: "stop" }, surface);
      error.message += `; input trace ${JSON.stringify(trace.entries)}`;
      throw error;
    }
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.trimEnd().endsWith("ddd한글은")),
      "committed Korean text did not reach the PTY before another key");
  });

  test(`${app.name}: eight Korean vowels and one Backspace retain an exact input trace`,
    { timeout: 60000 }, async (t) => {
      const s = await open(t, app);
      await fresh(s);
      const [terminal] = await ensureTerminals(s, 1);
      const surface = terminal.surface;
      await readScreenUntil(s, surface, (lines) => lines.some((line) => /[$%#>]$/.test(line)),
        "the shell prompt did not appear before the input trace");

      const artifactRoot = join(app.configDir, "logs", "ime-backspace-traces");
      mkdirSync(artifactRoot, { recursive: true });
      const artifactDir = mkdtempSync(join(artifactRoot, "F239-47-2-"));
      const manifest = { app: app.name, surface, sequence: [...Array(8).fill("k"), "Backspace", "Space"], steps: [] };
      const persist = (name, value) => {
        writeFileSync(join(artifactDir, name), `${JSON.stringify(value, null, 2)}\n`);
      };
      persist("manifest.json", manifest);
      t.diagnostic(`${app.name}: durable input trace directory ${artifactDir}`);

      manifest.clockPreflight = await machAbsoluteBoundary(s);
      persist("manifest.json", manifest);

      const original = (await s.request("diagnostics.input.source")).current;
      s.cleanup(() => s.request("diagnostics.input.source", { select: original }));
      await s.keepPointerOutside();
      const terminalView = await s.rect("terminal.view", undefined, surface);
      const x = terminalView.document.x + terminalView.x + terminalView.width / 2;
      const y = terminalView.document.y + terminalView.y + terminalView.height / 2;
      await s.pointer(x, y, "move", { activate: true });
      await s.until("host.window", (host) => host.active === true &&
        host.key === true, "the application did not become the active key window");
      await s.run("terminal.focus", {}, surface);
      await s.until("terminal.cursor", (cursor) => cursor.focused === true,
        "the declared terminal focus command did not focus the input region", { surface });
      await s.until("host.window", (host) => host.responder?.surface === surface &&
        host.regions.some((region) => region.surface === surface && region.focused),
      "the terminal focus command did not install its native responder");
      assert.equal((await s.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET,
        `the ${KOREAN_2SET} input source is not enabled`);

      let traceActive = false;
      let activeTraceName = "terminal-input";
      const traces = [];
      const startTrace = async (name) => {
        const result = await s.run("terminal.ime.trace", { action: "start" }, surface);
        assert.deepEqual(result, { enabled: true, overflow: false, entries: [] });
        activeTraceName = name;
        traceActive = true;
      };
      const stopTrace = async (key) => {
        const result = await s.run("terminal.ime.trace", { action: "stop" }, surface);
        traceActive = false;
        persist(`${key}-callbacks.json`, result.entries);
        traces.push({ key, entries: result.entries });
        t.diagnostic(`${app.name}: CALLBACKS ${JSON.stringify({ key, entries: result.entries })}`);
        assert.equal(result.overflow, false, `${key}: IME trace overflowed`);
        assert.ok(result.entries.length > 0, `${key}: no IME callback was recorded`);
        return result.entries;
      };
      s.cleanup(async () => {
        if (traceActive) await stopTrace(activeTraceName);
      });

      const observations = [];
      const referenceStates = [];
      const stateEventWaiters = new Set();
      const observeTerminal = async (group, key, index, baseline, stateEvents, expectedDocument) => {
        const eventOffset = observedStateEvents.length - stateEvents.length;
        let attempt = 0;
        const readSnapshot = async () => {
          attempt += 1;
          const compose = await s.get("terminal.compose", surface);
          const cursor = await s.get("terminal.cursor", surface);
          const screen = await presentedScreen(s, surface);
          const currentCompose = await s.get("terminal.compose", surface);
          const currentCursor = await s.get("terminal.cursor", surface);
          const host = await s.get("host.window");
          const region = host.regions.find((item) => item.surface === surface && item.name === "view");
          const currentEvents = observedStateEvents.slice(eventOffset);
          const snapshot = {
            attempt,
            baseline,
            compose,
            cursor,
            screen,
            currentCompose,
            currentCursor,
            region,
            stateEvents: currentEvents,
          };

          const firstReadMatchesReread = sameTerminalComposition(terminalCompositionState(compose, cursor),
            terminalCompositionState(currentCompose, currentCursor));
          const cursorMatchesCompose = terminalComposeMatchesPreedit(currentCompose, currentCursor);
          const statusesMatch = terminalObserverStatusesMatch(currentEvents, baseline,
            { compose: currentCompose, cursor: currentCursor, screen });
          const coherentReread = cursorMatchesCompose && statusesMatch;
          const baseScreenPresented = region?.presented?.generation === screen.frame.generation &&
            region.presented.raster === screen.frame.raster && region.presented.sequence >= screen.frame.sequence;
          const coherent = coherentReread && baseScreenPresented;
          snapshot.coherence = { firstReadMatchesReread, cursorMatchesCompose, coherentReread, statusesMatch,
            baseScreenPresented, stageDocumentMatches: false };
          snapshot.document = null;
          snapshot.expectedDocument = expectedDocument;
          const stateFile = `observer-${group}-${String(index).padStart(2, "0")}-${String(attempt).padStart(2, "2")}.json`;
          persist(stateFile, snapshot);
          let document = null;
          if (coherent) {
            try {
              document = visibleInputBeforeCursor(screen, currentCursor, prompt, currentCompose.text,
                `${key} terminal sample`);
            } catch (error) {
              snapshot.documentError = { name: error.name, message: error.message };
              persist(stateFile, snapshot);
              throw error;
            }
          }
          snapshot.document = document;
          snapshot.coherence.stageDocumentMatches = document === expectedDocument;
          persist(stateFile, snapshot);
          return { snapshot, coherent, document };
        };
        const waitForSample = (after, remaining) => waitForStateEvent(after, key,
          "terminal state did not reach the same-window AppKit document after a coherent sample", remaining);
        const selectedSample = await waitForTerminalStage(observedStateEvents, readSnapshot, waitForSample,
          expectedDocument, key, 1500);
        const snapshot = selectedSample.snapshot;
        const selected = selectCoherentTerminalObservation(snapshot);
        const { compose: acceptedCompose, cursor: acceptedCursor, screen: acceptedScreen,
          region, stateEvents: acceptedEvents } = selected;
        const observation = {
          group,
          index,
          key,
          stateEvents: acceptedEvents,
          beforeCompose: baseline.compose,
          compose: acceptedCompose,
          cursor: acceptedCursor,
          screen: acceptedScreen,
          screenText: textLines({ lines: acceptedScreen.rows }),
          frame: acceptedScreen.frame,
          presented: region.presented,
          nativeFrame: region.frame,
          session: await s.get("terminal.session", surface),
        };
        observations.push(observation);
        persist(`${group}-${String(index).padStart(2, "0")}.json`, observation);
        t.diagnostic(`${app.name}: INPUT ${JSON.stringify(observation)}`);
        assertTerminalStageCoherent({ screen: acceptedScreen, region, compose: acceptedCompose,
          cursor: acceptedCursor, stateEvents: acceptedEvents }, `${key} terminal state`);
        return observation;
      };

      const baselineScreen = await presentedScreen(s, surface);
      const baselineCursor = await s.get("terminal.cursor", surface);
      const baselineCompose = await s.get("terminal.compose", surface);
      assert.equal(terminalComposeMatchesPreedit(baselineCompose, baselineCursor), true,
        "the pre-key terminal composition baseline must be coherent");
      let knownState = { compose: baselineCompose, cursor: baselineCursor, screen: baselineScreen };
      const promptPrefix = terminalLineBeforeCursor(baselineScreen, baselineCursor, "empty terminal prompt");
      assert.ok(promptPrefix.length > 0, "the empty terminal prompt has no visible prefix");
      const prompt = { row: baselineCursor.row, col: 0, text: promptPrefix };
      manifest.prompt = prompt;
      persist("manifest.json", manifest);

      const observedStateEvents = [];
      const statusEventsPath = join(artifactDir, "status-events.jsonl");
      writeFileSync(statusEventsPath, "");
      const stateObserver = await startTerminalStatusObserver(s, surface, (event) => {
        appendFileSync(statusEventsPath, `${JSON.stringify(event)}\n`);
        observedStateEvents.push(event);
        for (const notify of [...stateEventWaiters]) notify();
      });
      s.cleanup(async () => {
        stateEventWaiters.clear();
        await stateObserver.stop();
      });
      const initialScreenEvent = await waitForObservedStatusEvent(observedStateEvents, 0,
        (notify) => { stateEventWaiters.add(notify); return () => stateEventWaiters.delete(notify); },
        "terminal.screen", (rows) => Array.isArray(rows), "initial terminal screen status", 1500);
      const initialComposeEvent = await waitForObservedStatusEvent(observedStateEvents, 0,
        (notify) => { stateEventWaiters.add(notify); return () => stateEventWaiters.delete(notify); },
        "terminal.compose", (compose) => compose && typeof compose === "object",
        "initial terminal compose status", 1500);
      const initialCursorEvent = await waitForObservedStatusEvent(observedStateEvents, 0,
        (notify) => { stateEventWaiters.add(notify); return () => stateEventWaiters.delete(notify); },
        "terminal.cursor", (cursor) => cursor?.frame && cursor?.render?.frame,
        "initial frame-bound terminal cursor status", 1500);
      assert.deepEqual(initialScreenEvent.value, baselineScreen.rows,
        "the observed initial terminal screen differs from the pre-key baseline rows");
      assert.equal(sameTerminalComposition(terminalCompositionState(initialComposeEvent.value, initialCursorEvent.value),
        terminalCompositionState(baselineCompose, baselineCursor)), true,
      "initial compose/cursor observer state differs from the pre-key baseline");
      assert.deepEqual(initialCursorEvent.value.frame, initialCursorEvent.value.render.frame,
        "initial cursor render does not belong to its frame");
      persist("observer-baseline.json", {
        screenEventIndex: observedStateEvents.indexOf(initialScreenEvent),
        composeEventIndex: observedStateEvents.indexOf(initialComposeEvent),
        cursorEventIndex: observedStateEvents.indexOf(initialCursorEvent),
        screenRows: initialScreenEvent.value,
        compose: initialComposeEvent.value,
        cursor: initialCursorEvent.value,
        baselineRowsMatched: true,
      });
      const waitForStateEvent = async (after, key,
        missingMessage = "no terminal compose, cursor or screen status notification followed the input",
        timeoutMs = 1500) => {
        try {
          return await waitForStateEventAfter(observedStateEvents, after, (notify) => {
            stateEventWaiters.add(notify);
            return () => stateEventWaiters.delete(notify);
          }, `${key}: ${missingMessage}`, timeoutMs);
        } catch (error) {
          const sample = { key, error: error.message, stateEvents: [...observedStateEvents] };
          try {
            sample.compose = await s.get("terminal.compose", surface);
            sample.cursor = await s.get("terminal.cursor", surface);
            sample.screen = await s.run("terminal.screen.read", {}, surface);
            sample.host = await s.get("host.window");
            sample.region = sample.host.regions.find((item) => item.surface === surface && item.name === "view");
          } catch (captureError) {
            sample.captureError = captureError.message;
          }
          persist(`status-notification-failure-${key.replaceAll(/[^a-zA-Z0-9-]/g, "-")}.json`, sample);
          error.message += `; raw status/frame snapshot saved in ${artifactDir}`;
          throw error;
        }
      };

      const capture = await s.record();
      let recordingResult = null;
      let capturePreserved = false;
      const preservedCaptureDir = join(artifactDir, "capture");
      const preserveCapture = () => {
        if (capturePreserved) return;
        cpSync(capture.frames, preservedCaptureDir, { recursive: true });
        capturePreserved = true;
        manifest.recording = preservedCaptureDir;
        manifest.sourceRecording = capture.frames;
        const sourceCallbackStatus = recordingResult.callbackStatus;
        persist("recording.json", { ...recordingResult, frames: preservedCaptureDir, sourceFrames: capture.frames,
          callbackStatus: join(preservedCaptureDir, basename(sourceCallbackStatus)), sourceCallbackStatus });
        persist("manifest.json", manifest);
      };
      s.cleanup(async () => {
        if (!recordingResult) recordingResult = await capture.stop({ after: 0 });
        preserveCapture();
      });

      assert.deepEqual(await s.request("diagnostics.input.reference", { action: "read" }), { open: false },
        "the disposable configuration must not contain an open AppKit reference");
      const reference = await s.request("diagnostics.input.reference", { action: "open" });
      assert.equal(reference.document, "", "the same-window AppKit reference must start empty");
      assert.equal(reference.marked, null, "the same-window AppKit reference must start without marked text");
      let referenceOpen = true;
      s.cleanup(async () => {
        if (referenceOpen) await s.request("diagnostics.input.reference", { action: "close" });
      });
      await s.pointer(reference.frame.x + reference.frame.w / 2, reference.frame.y + reference.frame.h / 2,
        "move", { activate: true });
      const focusedReference = await s.request("diagnostics.input.reference", { action: "focus" });
      assert.equal(focusedReference.focused, true, "the same-window AppKit reference must receive native focus");
      assert.equal((await s.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET,
        `the ${KOREAN_2SET} input source is not enabled for the reference`);

      const expectedReferenceDocuments = [
        ...Array.from({ length: 8 }, (_, index) => "ㅏ".repeat(index + 1)),
        "ㅏ".repeat(7),
        `${"ㅏ".repeat(7)} `,
      ];
      for (let index = 0; index < manifest.sequence.length; index++) {
        const key = manifest.sequence[index];
        const sent = key === "Space" ? "Space" : key;
        const started = performance.now();
        await s.press(sent);
        const acknowledged = performance.now();
        const step = { group: "reference", index: index + 1, key, started, acknowledged, state: null };
        manifest.steps.push({ group: step.group, index: step.index, key, started, acknowledged });
        persist(`reference-${String(index + 1).padStart(2, "0")}.json`, step);
        persist("manifest.json", manifest);
        const state = await s.request("diagnostics.input.reference", { action: "read" });
        step.state = state;
        referenceStates.push(state);
        persist(`reference-${String(index + 1).padStart(2, "0")}.json`, step);
        assert.equal(state.open, true, "the same-window AppKit reference closed during input");
        assert.equal(state.focused, true, `reference input ${index + 1} lost native focus`);
        assertReferenceRanges(state, `reference input ${index + 1}`);
        assert.equal(state.document, expectedReferenceDocuments[index],
          `reference input ${index + 1} ${key} produced an unexpected AppKit document`);
        t.diagnostic(`${app.name}: REFERENCE ${JSON.stringify(step)}`);
      }
      const referenceFinal = await s.request("diagnostics.input.reference", { action: "read" });
      persist("reference-final.json", referenceFinal);
      assert.equal(referenceFinal.open, true, "the same-window AppKit reference closed before final validation");
      assert.equal(referenceFinal.focused, true, "Space moved focus away from the AppKit reference");
      assertReferenceRanges(referenceFinal, "final AppKit reference state");
      assert.equal(referenceFinal.document, `${"ㅏ".repeat(7)} `,
        "the AppKit reference document after Space is unexpected");
      assert.equal(referenceFinal.marked, null, "Space did not commit the AppKit reference composition");
      await s.request("diagnostics.input.reference", { action: "close" });
      referenceOpen = false;

      const terminalViewAfterReference = await s.rect("terminal.view", undefined, surface);
      const terminalX = terminalViewAfterReference.document.x + terminalViewAfterReference.x + terminalViewAfterReference.width / 2;
      const terminalY = terminalViewAfterReference.document.y + terminalViewAfterReference.y + terminalViewAfterReference.height / 2;
      await s.pointer(terminalX, terminalY, "move", { activate: true });
      await s.until("host.window", (host) => host.active === true && host.key === true,
        "the application did not regain the active key window");
      const focusEventOffset = observedStateEvents.length;
      await s.run("terminal.focus", {}, surface);
      await waitForObservedStatusEvent(observedStateEvents, focusEventOffset, (notify) => {
        stateEventWaiters.add(notify);
        return () => stateEventWaiters.delete(notify);
      }, "terminal.cursor", (cursor) => cursor?.focused === true,
      "the terminal did not regain focus after the reference closed", 1500);
      await s.until("host.window", (host) => host.responder?.surface === surface &&
        host.regions.some((region) => region.surface === surface && region.focused),
      "the terminal did not regain its native responder after the reference closed");
      assert.equal((await s.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET,
        `the ${KOREAN_2SET} input source is not enabled for the terminal`);
      const terminalReady = {
        host: await s.get("host.window"),
        compose: await s.get("terminal.compose", surface),
        cursor: await s.get("terminal.cursor", surface),
      };
      persist("terminal-ready.json", terminalReady);
      assert.equal(terminalReady.host.active, true, "the terminal host is not the active application before key input");
      assert.equal(terminalReady.host.key, true, "the terminal host window is not key before key input");
      assert.equal(terminalReady.host.responder?.surface, surface, "the terminal is not the native responder before key input");

      const applyTerminalInput = (referenceState, observation, entries, index) => {
        const actual = visibleInputBeforeCursor(observation.screen, observation.cursor, prompt,
          observation.compose.text, `terminal input ${index}`);
        const line = terminalLineBeforeCursor(observation.screen, observation.cursor, `terminal input ${index}`);
        const committed = line.slice(promptPrefix.length);
        assertReferenceRanges(referenceState, `AppKit state after input ${index}`);
        return {
          expected: referenceState.document,
          actual,
          ptyCommitted: committed,
          preedit: observation.compose.text,
          nativeInserts: entries.filter((entry) => entry.kind === "native-insert").map((entry) => entry.text),
          terminalInputs: entries.filter((entry) => entry.kind === "terminal-input"),
        };
      };

      const visualStageInputs = [];
      let visualStages = [];
      for (let index = 0; index < 8; index++) {
        await startTrace(`terminal-k-${index + 1}`);
        const eventOffset = observedStateEvents.length;
        const startedBoundary = await machAbsoluteBoundary(s);
        const started = performance.now();
        await s.press("k");
        const acknowledgedBoundary = await machAbsoluteBoundary(s);
        const acknowledged = performance.now();
        manifest.steps.push({ group: "terminal", index: index + 1, key: "k", started, acknowledged,
          clockDomain: startedBoundary.clockDomain, startedMachAbsoluteNs: startedBoundary.machAbsoluteNs,
          acknowledgedMachAbsoluteNs: acknowledgedBoundary.machAbsoluteNs });
        persist("manifest.json", manifest);
        await waitForStateEvent(eventOffset, `k-${index + 1}`);
        const stateEvents = observedStateEvents.slice(eventOffset);
        const entries = await stopTrace(`terminal-k-${index + 1}`);
        assert.ok(terminalInputReceiptMatches(entries, "k"),
          `terminal key k ${index + 1} has no matching native or terminal input callback`);
        const observation = await observeTerminal("terminal", "k", index + 1, knownState, stateEvents,
          referenceStates[index].document);
        knownState = { compose: observation.compose, cursor: observation.cursor, screen: observation.screen };
        const comparison = applyTerminalInput(referenceStates[index], observation, entries, index + 1);
        persist(`comparison-${String(index + 1).padStart(2, "0")}.json`, {
          key: "k", expected: referenceStates[index], ...comparison,
          terminal: observation, callbacks: entries,
        });
        assert.equal(comparison.actual, comparison.expected,
          `input ${index + 1} k diverged: terminal committed-plus-preedit ${JSON.stringify(comparison.actual)} ` +
          `differs from AppKit document ${JSON.stringify(comparison.expected)}`);
        visualStageInputs.push({ key: `k-${index + 1}`, expectedDocument: comparison.expected,
          observation, prompt, clockDomain: startedBoundary.clockDomain,
          startedMachAbsoluteNs: startedBoundary.machAbsoluteNs });
      }

      const cursorBeforeBackspace = knownState.cursor;
      await startTrace("terminal-Backspace");
      const backspaceEventOffset = observedStateEvents.length;
      const backspaceStartedBoundary = await machAbsoluteBoundary(s);
      const backspaceStarted = performance.now();
      await s.press("Backspace");
      const backspaceAcknowledgedBoundary = await machAbsoluteBoundary(s);
      const backspaceAcknowledged = performance.now();
      manifest.steps.push({ group: "terminal", index: 9, key: "Backspace", started: backspaceStarted,
        acknowledged: backspaceAcknowledged, clockDomain: backspaceStartedBoundary.clockDomain,
        startedMachAbsoluteNs: backspaceStartedBoundary.machAbsoluteNs,
        acknowledgedMachAbsoluteNs: backspaceAcknowledgedBoundary.machAbsoluteNs });
      persist("manifest.json", manifest);
      await waitForStateEvent(backspaceEventOffset, "Backspace");
      const backspaceEntries = await stopTrace("terminal-Backspace");
      assert.ok(terminalInputReceiptMatches(backspaceEntries, "Backspace"),
        "Backspace has no matching native-key or deleteBackward terminal callback");
      const backspaceObservation = await observeTerminal("terminal", "Backspace", 9, knownState,
        observedStateEvents.slice(backspaceEventOffset), referenceStates[8].document);
      knownState = { compose: backspaceObservation.compose, cursor: backspaceObservation.cursor,
        screen: backspaceObservation.screen };
      const backspaceComparison = applyTerminalInput(referenceStates[8], backspaceObservation, backspaceEntries, 9);
      persist("comparison-09.json", { key: "Backspace", expected: referenceStates[8], ...backspaceComparison,
        terminal: backspaceObservation, callbacks: backspaceEntries });
      assert.equal(backspaceComparison.actual, backspaceComparison.expected,
        `Backspace diverged: terminal committed-plus-preedit ${JSON.stringify(backspaceComparison.actual)} ` +
        `differs from AppKit document ${JSON.stringify(backspaceComparison.expected)}`);
      visualStageInputs.push({ key: "Backspace", expectedDocument: backspaceComparison.expected,
        observation: backspaceObservation, prompt, clockDomain: backspaceStartedBoundary.clockDomain,
        startedMachAbsoluteNs: backspaceStartedBoundary.machAbsoluteNs });

      const beforeSpace = knownState.compose;
      const cursorBeforeSpace = knownState.cursor;
      await startTrace("terminal-Space");
      const spaceEventOffset = observedStateEvents.length;
      const spaceStartedBoundary = await machAbsoluteBoundary(s);
      const spaceStarted = performance.now();
      await s.press("Space");
      const spaceAcknowledgedBoundary = await machAbsoluteBoundary(s);
      const spaceAcknowledged = performance.now();
      manifest.steps.push({ group: "terminal", index: 10, key: "Space", started: spaceStarted,
        acknowledged: spaceAcknowledged, clockDomain: spaceStartedBoundary.clockDomain,
        startedMachAbsoluteNs: spaceStartedBoundary.machAbsoluteNs,
        acknowledgedMachAbsoluteNs: spaceAcknowledgedBoundary.machAbsoluteNs });
      persist("manifest.json", manifest);
      await waitForStateEvent(spaceEventOffset, "Space");
      const spaceEntries = await stopTrace("terminal-Space");
      assert.ok(terminalInputReceiptMatches(spaceEntries, "Space"),
        "Space has no matching native-key or space-insert callback");
      const spaceObservation = await observeTerminal("terminal", "Space", 10, knownState,
        observedStateEvents.slice(spaceEventOffset), referenceStates[9].document);
      const spaceComparison = applyTerminalInput(referenceStates[9], spaceObservation, spaceEntries, 10);
      persist("comparison-10.json", { key: "Space", expected: referenceStates[9], ...spaceComparison,
        terminal: spaceObservation, callbacks: spaceEntries });
      assert.equal(spaceComparison.actual, spaceComparison.expected,
        `Space diverged: terminal committed-plus-preedit ${JSON.stringify(spaceComparison.actual)} ` +
        `differs from AppKit document ${JSON.stringify(spaceComparison.expected)}`);
      visualStageInputs.push({ key: "Space", expectedDocument: spaceComparison.expected,
        observation: spaceObservation, prompt, clockDomain: spaceStartedBoundary.clockDomain,
        startedMachAbsoluteNs: spaceStartedBoundary.machAbsoluteNs });
      persist("terminal-final.json", { backspaceObservation, spaceObservation, beforeSpace, cursorBeforeBackspace,
        cursorBeforeSpace });
      assert.equal(observations.length, 10, "the trace omitted an input state or presented frame");
      assert.equal(traces.length, 10, "the trace omitted a native callback batch");
      assert.equal(visualStageInputs.length, 10, "the trace omitted a visual input stage");
      assert.equal(referenceStates.length, 10, "the trace omitted a same-window AppKit reference state");
      assert.equal(manifest.steps.length, 20, "the trace omitted an acknowledged reference or terminal input");
      const terminalSequenceEndBoundary = await machAbsoluteBoundary(s);
      const { displayed } = await s.presented();
      const recording = await capture.stop({ after: displayed + 100 });
      recordingResult = recording;
      preserveCapture();
      const framePaths = frames(capture.frames);
      const preservedCallbackStatus = join(preservedCaptureDir, basename(recording.callbackStatus));
      persist("recording.json", { ...recording, frames: preservedCaptureDir, sourceFrames: capture.frames,
        callbackStatus: preservedCallbackStatus, sourceCallbackStatus: recording.callbackStatus });
      const decoded = framePaths.map(readFrame);
      assert.ok(decoded.length >= 2, `${app.name}: recording did not span both comparison gestures`);
      assert.equal(decoded.length, recording.count, `${app.name}: a captured frame is missing from disk`);
      assert.equal(recording.limited, false, `${app.name}: capture reached its frame limit`);
      const frameGaps = decoded.slice(1).map((frame, index) => ({
        from: basename(framePaths[index]),
        to: basename(framePaths[index + 1]),
        milliseconds: frame.time - decoded[index].time,
      }));
      const longestFrameGap = Math.max(...frameGaps.map(({ milliseconds }) => milliseconds));
      persist("recording.json", { ...recording, frames: preservedCaptureDir, sourceFrames: capture.frames,
        frameFiles: framePaths.map((path) => basename(path)),
        frameGaps, longestFrameGap, frameCount: decoded.length, callbackStatus: preservedCallbackStatus,
        sourceCallbackStatus: recording.callbackStatus });
      assert.ok(longestFrameGap <= 33, `${app.name}: capture has a ${longestFrameGap}ms frame gap`);
      assert.equal(recording.callbackStatus, join(capture.frames, "callback-status.jsonl"),
        `${app.name}: stop did not identify the recording callback trace`);
      const callbackText = readFileSync(recording.callbackStatus, "utf8");
      assert.notEqual(callbackText.trim(), "", `${app.name}: capture callback trace is empty`);
      writeFileSync(join(artifactDir, "capture-callback-status.jsonl"), callbackText);
      const callbackStatus = callbackText.trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(callbackStatus.length <= 4096, `${app.name}: recording callback trace exceeded its declared capacity`);
      callbackStatus.forEach((item, index) => {
        assert.equal(item.sequence, index + 1, `${app.name}: capture callback sequence has a gap`);
        assert.ok(item.status === null || Number.isInteger(item.status), `${app.name}: callback status is invalid`);
        for (const field of ["callbackTime", "writeStartTime", "writeCompleteTime"]) {
          assert.ok(typeof item[field] === "string" && /^\d+$/.test(item[field]),
            `${app.name}: callback ${field} is missing or invalid`);
        }
        assert.ok(BigInt(item.callbackTime) <= BigInt(item.writeStartTime)
          && BigInt(item.writeStartTime) <= BigInt(item.writeCompleteTime),
        `${app.name}: callback processing times are out of order`);
        assert.ok(Number.isSafeInteger(item.machTimebaseNumerator) && item.machTimebaseNumerator > 0
          && Number.isSafeInteger(item.machTimebaseDenominator) && item.machTimebaseDenominator > 0,
        `${app.name}: callback mach timebase is invalid`);
        assert.equal(item.machTimebaseNumerator, callbackStatus[0].machTimebaseNumerator,
          `${app.name}: callback mach timebase numerator changed during capture`);
        assert.equal(item.machTimebaseDenominator, callbackStatus[0].machTimebaseDenominator,
          `${app.name}: callback mach timebase denominator changed during capture`);
        assert.ok(item.frame === null || typeof item.frame === "string", `${app.name}: callback frame field is invalid`);
        if (item.frame !== null) {
          assert.equal(item.status, 0, `${app.name}: incomplete callback names a frame`);
          assert.ok(typeof item.displayTime === "string" && /^\d+$/.test(item.displayTime),
            `${app.name}: frame callback has no display time`);
        }
      });
      assert.deepEqual(callbackStatus.flatMap((item) => item.frame === null ? [] : [item.frame]),
        framePaths.map((path) => basename(path)),
      `${app.name}: captured frame callbacks and files differ`);
      let frameStatus;
      let sources = [];
      let missingStates = [];
      let timedStages = [];
      let visualMeasurements;
      try {
        persist("visual-stage-inputs.json", visualStageInputs);
        frameStatus = indexFrameStatus(observedStateEvents, prompt, visibleInputBeforeCursor);
        visualStages = visualStageInputs.map((stage) => ({
          ...planVisualStage({ ...stage, frameStatus }),
          clockDomain: stage.clockDomain,
          startedMachAbsoluteNs: stage.startedMachAbsoluteNs,
        }));
        ({ sources, missingStates } = readRetainedSources(capture.frames, frameStatus));
        timedStages = visualStages.map((stage, index) => ({ ...stage,
          endedMachAbsoluteNs: visualStages[index + 1]?.startedMachAbsoluteNs ??
            terminalSequenceEndBoundary.machAbsoluteNs }));
        const samplesByStage = capturesByInputStage(frameCallbacks.map(({ callback }) => ({
          name: callback.frame, callback,
        })), decoded, timedStages);
        visualMeasurements = timedStages.map((stage) => evaluateVisualStages({
          captures: samplesByStage.get(stage.key),
          sources,
          stages: [stage],
          criteria: { colorDistance: 32, minimumGlyphPixels: 2, minimumUnderlineCoverage: 0.75 },
        })[0]);
      } catch (error) {
        persist("visual-measurements.json", {
          collectionError: { name: error.name, error: error.message },
          inputStages: visualStageInputs,
          targetStages: visualStages.map(({ key, frame, cells, glyphs, semantic }) =>
            ({ key, frame, cells, glyphs, semantic })),
          retainedSourceCount: sources.length,
          missingSourceStates,
          sourceStatusRejections: frameStatus?.rejections ?? [],
          callbackStatus: callbackStatus.map(({ frame, imageMatch }) => ({ frame, imageMatch })),
        });
        throw error;
      }
      const visualRecord = {
        targetStages: timedStages.map(({ key, frame, cells, glyphs, semantic, clockDomain,
          startedMachAbsoluteNs, endedMachAbsoluteNs }) =>
          ({ key, frame, cells, glyphs, semantic, clockDomain, startedMachAbsoluteNs, endedMachAbsoluteNs })),
        retainedSourceCount: sources.length,
        missingSourceStates,
        sourceStatusRejections: frameStatus.rejections,
        sampleCount: frameCallbacks.length,
        imageMatch: callbackStatus.map(({ frame, imageMatch }) => ({ frame, imageMatch })),
        visualMeasurements,
      };
      persistThenRequireVisualProof(visualMeasurements, visualRecord,
        (record) => persist("visual-measurements.json", record), app.name);
      assert.equal(visualStages.length, 10, `${app.name}: visual calculator omitted an input stage`);
      persist("recording.json", { ...recording, frames: preservedCaptureDir, sourceFrames: capture.frames,
        frameFiles: framePaths.map((path) => basename(path)), frameGaps, longestFrameGap, frameCount: decoded.length,
        callbackStatus: preservedCallbackStatus, sourceCallbackStatus: recording.callbackStatus });
      persist("manifest.json", { ...manifest, recording: preservedCaptureDir,
        sourceRecording: capture.frames, completed: true });
      t.diagnostic(`${app.name}: comparison trace saved in ${artifactDir}; frames ${decoded.length}; callbacks ${JSON.stringify(traces)}`);
    });
}
