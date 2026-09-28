// 실제 TUI에서 제3지점 뒤 즉시 재시도한다. 실패한 뒤의 회복은 통과로 바꾸지 않는다.
import assert from "node:assert/strict";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { APPS, open, fresh } from "../app.mjs";
import { ensureTerminals, readScreenUntil } from "../terminal-screen.mjs";
import { frames, pixel, readFrame } from "../frame.mjs";
import { assertTuiCycle, assertTuiGesture } from "../tui-drag-measurement.mjs";
import { bringFront, click, post, requireTrusted, screenCenter } from "./hid.mjs";

const COLORS_DIFFER = (a, b) => a.some((channel, index) => Math.abs(channel - b[index]) > 16);
const cellsIn = (frame, region, session, row, count) => Array.from({ length: count }, (_, col) =>
  pixel(frame, Math.round((region.frame.x + (col + 0.12) * session.cellWidth) * frame.scale),
    Math.round((region.frame.y + (row + 0.12) * session.cellHeight) * frame.scale)));

for (const app of Object.values(APPS)) {
  test(`${app.name}: actual TUI drag survives third-point clicks for 60 uninterrupted cycles`, { timeout: 900000 }, async (t) => {
    requireTrusted();
    assert.ok([realpathSync(tmpdir()), realpathSync("/tmp")].includes(realpathSync(dirname(app.configDir))) &&
      basename(app.configDir).startsWith("soksak-check-"), "TUI fixture requires a disposable config directory");
    const s = await open(t, app);
    assert.ok(s, "the matching host bundle must be running");
    await fresh(s);
    const [{ surface }] = await ensureTerminals(s, 1);
    await s.run("terminal.input", { bytes: "tui-program\r" }, surface);
    const lines = await readScreenUntil(s, surface, (lines) => lines.some((line) => line.includes("Ask TUI")), "TUI prompt did not appear");
    const row = lines.findIndex((line) => line.includes("TUI header"));
    assert.ok(row >= 0, "TUI output header is missing");
    const text = "header";
    const column = lines[row].indexOf(text);
    const promptRow = lines.findIndex((line) => line.includes("Ask TUI"));
    const session = await s.get("terminal.session", surface);
    const view = await s.rect("terminal.view", undefined, surface);
    const center = await bringFront(s, app, view);
    const origin = { x: center.x - view.width / 2, y: center.y - view.height / 2 };
    const point = (col, line) => ({ x: origin.x + col * session.cellWidth, y: origin.y + (line + 0.5) * session.cellHeight });
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
      endpoint: JSON.parse(readFileSync(join(app.configDir, "endpoint.json"), "utf8")), tui: lines[row], surface, cycles: [] };
    delete evidence.endpoint.token;
    const evidencePath = join(tmpdir(), `soksak-tui-drag-${app.name}.json`);
    t.after(() => { writeFileSync(evidencePath, JSON.stringify(evidence, null, 2)); t.diagnostic(`evidence: ${evidencePath}`); });
    const screenRow = async () => (await s.get("terminal.screen", surface))[row].map((cell) =>
      ({ ch: cell.ch ?? " ", inverse: cell.inverse === true }));
    await s.request("diagnostics.capture.start", {});
    const initialPresentation = await s.presented();
    const { frames: initialDir } = await s.request("diagnostics.capture.stop", { after: initialPresentation.displayed });
    let baseline;
    try { baseline = cellsIn(readFrame(frames(initialDir).at(-1)), region, session, row, session.cols); }
    finally { rmSync(initialDir, { recursive: true, force: true }); }

    const measure = async (steps) => {
      await s.run("terminal.pointer.trace", { action: "start" }, surface);
      const before = await s.get("host.window");
      assert.ok(before.active && before.key && !before.occluded, `inactive test window: ${JSON.stringify(before)}`);
      const recording = await s.request("diagnostics.capture.start", {});
      let sent;
      let trace;
      let waitError;
      let stopped = false;
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
        trace = await s.run("terminal.pointer.trace", { action: "stop" }, surface);
        const displayed = await s.presented();
        await s.request("diagnostics.capture.stop", { after: displayed.displayed });
        stopped = true;
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
        const textCells = Array.from({ length: text.length }, (_, i) => column + i);
        const recordedCells = textCells.flatMap((col) => COLORS_DIFFER(samples.at(-1).colors[col], baseline[col]) ? [`${row}:${col}`] : []);
        const selectedCells = textCells.flatMap((col) => screen[row]?.[col]?.inverse === true ? [`${row}:${col}`] : []);
        const selectionByFrame = samples.map((sample) => ({ time: sample.time,
          selectedCells: textCells.flatMap((col) => COLORS_DIFFER(sample.colors[col], baseline[col]) ? [col] : []) }));
        const dom = trace.entries.filter((entry) => entry.kind === "pointer-dom");
        const pointerStart = { x: region.frame.x + from.x - origin.x, y: region.frame.y + from.y - origin.y };
        const pointerEnd = { x: region.frame.x + to.x - origin.x, y: region.frame.y + to.y - origin.y };
        return {
          expected: inputs.map(({ body: { inputId, phase } }) => ({ inputId, phase })), events: results,
          dom, pointerStart, pointerEnd,
          visual: { expectedCells: Array.from({ length: text.length }, (_, i) => `${row}:${column + i}`), selectedCells, recordedCells },
          capture: { first: samples[0].time, last: samples.at(-1).time, frameCount: samples.length,
            maxGap: Math.max(...samples.slice(1).map((item, i) => item.time - samples[i].time)), inputStart: sent[0], inputEnd: sent.at(-1) },
          overflow: trace.overflow, waitError, trace, before, after: await s.get("host.window"),
          terminal: await s.get("terminal.session", surface), selectionByFrame,
        };
      } finally {
        if (!stopped) await s.request("diagnostics.capture.stop", {}).catch((error) => {
          t.diagnostic(`capture stop failed: ${String(error)}`);
          throw error;
        });
        rmSync(recording.frames, { recursive: true, force: true });
      }
    };

    for (const steps of [30, 90]) for (let third = 0; third < thirds.length; third++) for (let repeat = 0; repeat < 10; repeat++) {
      const cycle = { steps, third, repeat, first: await measure(steps) };
      click(thirds[third].x, thirds[third].y);
      cycle.screenAfterThird = await screenRow();
      cycle.direct = await measure(steps);
      cycle.screenAfterDirect = await screenRow();
      evidence.cycles.push(cycle);
      try { assertTuiCycle(cycle); }
      catch (failure) {
        click(otherPoint.x, otherPoint.y);
        click(thirds[0].x, thirds[0].y);
        cycle.recovery = await measure(steps);
        try { assertTuiGesture(cycle.recovery); cycle.recovered = true; }
        catch (error) { cycle.recovered = false; cycle.recoveryError = String(error); }
        throw failure;
      }
      t.diagnostic(`${app.name} cycle ${evidence.cycles.length}/60 passed`);
    }
  });
}
