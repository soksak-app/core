// After a mouse-reporting fixture TUI is switched on, retries immediately after the third point. A recovery after a failure is not turned into a pass.
import assert from "node:assert/strict";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { ensureTerminals, readScreenUntil } from "../terminal-screen.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";
import { assertTuiGesture, gestureDom } from "../tui-drag-measurement.mjs";
import { HEADER_WORD, LAUNCH, PROMPT } from "../fixture-tui.mjs";
import { bringFront, click, post, requireTrusted, screenCenter } from "./hid.mjs";

const COLORS_DIFFER = (a, b) => a.some((channel, index) => Math.abs(channel - b[index]) > 16);
const DIAGNOSE_THIRD_POINTS = process.env.SOKSAK_TUI_DRAG_DIAGNOSTIC === "1";
const SELECTION_SETTLE_MS = 1000;
const cellsIn = (frame, region, session, row, count) => Array.from({ length: count }, (_, col) =>
  pixel(frame, Math.round((region.frame.x + (col + 0.12) * session.cellWidth) * frame.scale),
    Math.round((region.frame.y + (row + 0.12) * session.cellHeight) * frame.scale)));

for (const app of Object.values(APPS)) {
  test(`${app.name}: a fixture TUI drag survives third-point clicks in three cycles`, { timeout: 180000 }, async (t) => {
    requireTrusted();
    assert.ok([realpathSync(tmpdir()), realpathSync("/tmp")].includes(realpathSync(dirname(app.configDir))) &&
      basename(app.configDir).startsWith("soksak-check-"), "the fixture TUI check requires a disposable config directory");
    const s = await open(t, app);
    assert.ok(s, "the matching host bundle must be running");
    await fresh(s);
    const [{ surface }] = await ensureTerminals(s, 1);
    const session = await s.get("terminal.session", surface);
    const view = await s.rect("terminal.view", undefined, surface);
    const center = await bringFront(s, app, view);
    const origin = { x: center.x - view.width / 2, y: center.y - view.height / 2 };
    const point = (col, line) => ({ x: origin.x + col * session.cellWidth, y: origin.y + (line + 0.5) * session.cellHeight });
    await s.run("terminal.input", { bytes: LAUNCH }, surface);
    const lines = await readScreenUntil(s, surface, (lines) => lines.some((line) => line.includes(PROMPT)), "the fixture TUI prompt did not appear");
    const row = lines.findIndex((line) => line.includes(HEADER_WORD));
    assert.ok(row >= 0, "the fixture TUI header is missing");
    const text = HEADER_WORD;
    const column = lines[row].indexOf(text);
    const promptRow = lines.findIndex((line) => line.includes(PROMPT));
    const from = point(column + 0.2, row);
    const to = point(column + text.length + 0.2, row);
    const thirds = [point(18, promptRow), point(column + text.length + 5, row), point(35, Math.floor((row + promptRow) / 2))];
    const surfaces = await s.get("core.surfaces");
    const other = surfaces.find((entry) => entry.visible && entry.surface !== surface);
    assert.ok(other, "another card is required for conditional recovery");
    const otherPoint = await screenCenter(s, { x: other.declared.x, y: other.declared.y,
      width: other.declared.w, height: other.declared.h, document: { x: 0, y: 0 } });
    const region = (await s.get("host.window")).regions.find((entry) => entry.surface === surface && entry.name === "view");
    assert.ok(region, "terminal native region is missing");
    const evidence = { app: app.name, binarySha256: createHash("sha256").update(readFileSync(app.binary)).digest("hex"),
      endpoint: JSON.parse(readFileSync(join(app.configDir, "endpoint.json"), "utf8")), header: lines[row], surface, cycles: [] };
    delete evidence.endpoint.token;
    const evidencePath = join(tmpdir(), `soksak-tui-drag-${app.name}.json`);
    s.cleanup(() => { writeFileSync(evidencePath, JSON.stringify(evidence, null, 2)); t.diagnostic(`evidence: ${evidencePath}`); });
    const screenRow = async () => (await s.get("terminal.screen", surface))[row].map((cell) =>
      ({ ch: cell.ch ?? " ", inverse: cell.inverse === true }));
    await s.request("diagnostics.capture.start", {});
    const initialPresentation = await s.presented();
    const { frames: initialDir } = await s.request("diagnostics.capture.stop", { after: initialPresentation.displayed });
    let baseline;
    try { baseline = cellsIn(readFrame(frames(initialDir).at(-1)), region, session, row, session.cols); }
    finally { rmSync(initialDir, { recursive: true, force: true }); }

    const textCells = Array.from({ length: text.length }, (_, i) => column + i);
    const measure = async (steps, { waitForSelection = false } = {}) => {
      await s.run("terminal.pointer.trace", { action: "start" }, surface);
      const before = await s.get("host.window");
      assert.ok(before.active && before.key && !before.occluded, `inactive test window: ${JSON.stringify(before)}`);
      const screenBefore = await s.get("terminal.screen", surface);
      const selectedBefore = textCells.filter((col) => screenBefore[row]?.[col]?.inverse === true);
      const recording = await s.record();
      let sent;
      let trace;
      let waitError;
      let selectionWaitError;
      let selectionWaitMs;
      let selectionAfterWaitCells;
      try {
        sent = post([{ type: "move", ...from }, { type: "down", ...from },
          ...Array.from({ length: steps }, (_, i) => ({ type: "drag", x: from.x + (to.x - from.x) * (i + 1) / steps,
            y: from.y, wait: i === steps - 1 ? 150 : 16 })), { type: "up", ...to }]);
        try {
          await s.until("terminal.pointer.trace", (value) => {
            const up = value.entries.findLast((entry) => entry.kind === "pointer-sent" && entry.body.operation === "mouse" && entry.body.phase === "up");
            return up && value.entries.some((entry) => entry.kind === "pointer-result" && entry.body.inputId === up.body.inputId);
          }, "the current drag has no matching mouse-up result", { surface, timeout: 5000 });
        } catch (error) { waitError = String(error); }
        // Measures the PTY transfer state after the gesture. This observation separates a successful write from reception by the child,
        // and the kernel queue has no notification, so it can only be seen by samples: it is measured once right after and once after the selection settles.
        // If written grows between the samples, the child produced output after mouse-up, which is evidence that separates the parsing and
        // rendering stages.
        const ptySamples = [];
        let ptyPendingError;
        const ptyStarted = performance.now();
        const samplePtyPending = async () => {
          const { pending, written } = await s.run("terminal.pty.pending", {}, surface);
          ptySamples.push({ pending, written, at: Math.round(performance.now() - ptyStarted) });
        };
        try { await samplePtyPending(); } catch (error) { ptyPendingError = String(error); }
        if (waitForSelection) {
          const selectionWaitStarted = performance.now();
          try {
            await s.until("terminal.screen", (lines) => textCells.every((col) => lines[row]?.[col]?.inverse === true),
              `the fixture TUI selection was not presented within ${SELECTION_SETTLE_MS}ms of the PTY mouse-up`,
              { surface, timeout: SELECTION_SETTLE_MS });
          } catch (error) {
            const detail = error.message?.split(" (status ")[0] ?? String(error);
            selectionWaitError = `${error.code ?? "ERROR"}: ${detail}`;
          }
          try { await samplePtyPending(); } catch (error) { ptyPendingError = String(error); }
          selectionWaitMs = performance.now() - selectionWaitStarted;
          const afterWait = await s.get("terminal.screen", surface);
          selectionAfterWaitCells = textCells.filter((col) => afterWait[row]?.[col]?.inverse === true);
        }
        trace = await s.run("terminal.pointer.trace", { action: "stop" }, surface);
        const displayed = await s.presented();
        // The commitment of the selection state and the raster presentation of its fill are separate. Passing only the last presentation time could stop the recording at a frame in which the fill
        // has not yet reached the stream, so a margin that covers the presentation interval and the composition delay
        // is added so that the last recorded frame holds the committed selection.
        await recording.stop({ after: displayed.displayed + 0.25 });
        const files = frames(recording.frames);
        const samples = files.map((file) => {
          const frame = readFrame(file);
          return { time: frame.time, colors: cellsIn(frame, region, session, row, session.cols) };
        });
        const queued = trace.entries.filter((e) => e.kind === "pointer-sent" && e.body.operation === "mouse");
        const start = queued.findIndex((e) => e.body.phase === "down");
        const inputs = queued.slice(start).filter((e) => e.body.pressed || e.body.phase === "up");
        const ids = new Set(inputs.map((e) => e.body.inputId));
        const results = trace.entries.filter((e) => e.kind === "pointer-result" && ids.has(e.body.inputId)).map((e) => e.body);
        const screen = await s.get("terminal.screen", surface);
        const recordedCells = textCells.flatMap((col) => COLORS_DIFFER(samples.at(-1).colors[col], baseline[col]) ? [`${row}:${col}`] : []);
        const selectedCells = textCells.flatMap((col) => screen[row]?.[col]?.inverse === true ? [`${row}:${col}`] : []);
        const selectionByFrame = samples.map((sample) => ({ time: sample.time,
          selectedCells: textCells.flatMap((col) => COLORS_DIFFER(sample.colors[col], baseline[col]) ? [col] : []) }));
        const dom = gestureDom(trace.entries);
        const pointerStart = { x: region.frame.x + from.x - origin.x, y: region.frame.y + from.y - origin.y };
        const pointerEnd = { x: region.frame.x + to.x - origin.x, y: region.frame.y + to.y - origin.y };
        return {
          expected: inputs.map(({ body: { inputId, phase } }) => ({ inputId, phase })), events: results,
          dom, pointerStart, pointerEnd,
          visual: { expectedCells: Array.from({ length: text.length }, (_, i) => `${row}:${column + i}`), selectedCells, recordedCells },
          capture: { first: samples[0].time, last: samples.at(-1).time, frameCount: samples.length,
            maxGap: Math.max(...samples.slice(1).map((item, i) => item.time - samples[i].time)), inputStart: sent[0], inputEnd: sent.at(-1) },
          overflow: trace.overflow, waitError, selectionWaitError, selectionWaitMs, selectionAfterWaitCells,
          ptyPending: { samples: ptySamples }, ptyPendingError,
          screenBefore, selectedBefore, trace, before, after: await s.get("host.window"),
          terminal: await s.get("terminal.session", surface), selectionByFrame,
        };
      } finally {
        // A failure to stop the recording stops the session cleanup (Session.record).
        rmSync(recording.frames, { recursive: true, force: true });
      }
    };

    const failures = [];
    // Passes through the three areas of the third point once each, and the middle cycle uses a slow drag. The repeat of an intermittent failure uses the repeat target.
    const plan = [{ third: 0, steps: 30 }, { third: 1, steps: 90 }, { third: 2, steps: 30 }];
    for (const [repeat, { third, steps }] of plan.entries()) {
      const cycle = { steps, third, repeat, first: await measure(steps, { waitForSelection: true }) };
      click(thirds[third].x, thirds[third].y);
      cycle.screenAfterThird = await screenRow();
      cycle.screenAfterThirdSelectedCells = textCells.filter((col) => cycle.screenAfterThird[col]?.inverse === true);
      cycle.direct = await measure(steps, { waitForSelection: true });
      cycle.screenAfterDirect = await screenRow();
      evidence.cycles.push(cycle);
      try { assertTuiGesture(cycle.first); }
      catch (error) { cycle.firstError = String(error); }
      try { assertTuiGesture(cycle.direct); }
      catch (error) { cycle.directError = String(error); }
      if (cycle.firstError || cycle.directError) {
        cycle.failedPhases = [cycle.firstError && "first", cycle.directError && "direct"].filter(Boolean);
        const failure = new Error(`${app.name} drag failed in ${cycle.failedPhases.join(" and ")} phase`);
        failures.push(cycle);
        click(otherPoint.x, otherPoint.y);
        click(thirds[0].x, thirds[0].y);
        const focusWaitStarted = Date.now();
        try {
          cycle.focusSettledState = await s.until("host.window", (window) => window.active && window.key &&
            window.responder.owner === "native" && window.responder.surface === surface,
          "terminal native responder did not settle after the prompt click", { timeout: 1500 });
        } catch (error) {
          cycle.focusSettleError = String(error);
          cycle.focusAfterTimeout = await s.get("host.window");
        }
        cycle.focusSettleDurationMs = Date.now() - focusWaitStarted;
        try {
          cycle.recovery = await measure(steps, { waitForSelection: true });
          assertTuiGesture(cycle.recovery);
          cycle.recovered = true;
        } catch (error) {
          cycle.recovered = false;
          cycle.recoveryError = String(error);
        }
        if (!DIAGNOSE_THIRD_POINTS) throw failure;
        t.diagnostic(`${app.name} diagnostic third=${third} failed ${cycle.failedPhases.join("+")}; focus=${cycle.focusSettledState ? "settled" : "unsettled"}; recovery=${cycle.recovered}`);
      }
      if (!DIAGNOSE_THIRD_POINTS) t.diagnostic(`${app.name} cycle ${evidence.cycles.length}/${plan.length} passed`);
    }
    if (failures.length) assert.equal(failures.length, 0,
      `${failures.length}/${evidence.cycles.length} diagnostic cycles failed; each failure phase and complete evidence are retained`);
  });
}
