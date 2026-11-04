// A drag that selects text in a terminal whose program redraws a status line: the selection highlight of every recorded frame
// grows along the row and ends at the cell under the pointer. A cell mapping that differs, or a highlight that stays behind
// the pointer after the release, fails here (the reply queue of the page: terminal plugin P105).
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";
import { fresh } from "./fixture.mjs";
import { ensureTerminals, isColor, readScreenUntil, selectionBackground } from "./terminal-screen.mjs";

async function closeTerminalTabs(s) {
  const grid = await s.get("core.grid");
  for (const tab of grid.cards.flatMap((card) => card.tabs).filter((item) => item.plugin === "terminal")) {
    await s.run("core.tab.close", { tab: tab.id });
  }
}

const START = 5;
const STEPS = 30;

for (const app of Object.values(APPS)) {
  test(`${app.name}: the selection highlight of a drag follows the pointer while a status line redraws`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    s.cleanup(() => closeTerminalTabs(s));
    const metrics = await s.until("terminal.session", (state) => Boolean(state?.sessionId),
      "the terminal session did not open", { surface });
    assert.ok(metrics.rows > 6 && metrics.cols > START + STEPS + 2, `terminal grid is too small: ${metrics.cols}×${metrics.rows}`);
    const row = 2;
    const text = "x".repeat(metrics.cols - 1);
    await s.run("terminal.input", {
      bytes: `clear; printf '\\033[${row + 1};1H${text}'; i=0; while :; do i=$((i+1)); ` +
        `printf '\\0337\\033[${metrics.rows};1HSTATUS-%s\\0338' $i; sleep 0.05; done\r`,
    }, surface);
    await readScreenUntil(s, surface, (screen) => screen.some((line) => line.includes("STATUS-")),
      "the status line did not render");

    const view = await s.rect("terminal.view", undefined, surface);
    const originX = view.document.x + view.x;
    const originY = view.document.y + view.y;
    const y = originY + (row + 0.5) * metrics.cellHeight;
    const pointerAt = (col) => originX + (col + 0.5) * metrics.cellWidth;
    const last = START + STEPS;
    const { displayed } = await s.presented();
    const recording = await s.record();
    await s.pointer(pointerAt(START), y, "down", { button: "left" });
    for (let step = 1; step <= STEPS; step += 1) await s.pointer(pointerAt(START + step), y, "drag", { button: "left" });
    await s.pointer(pointerAt(last), y, "up", { button: "left" });
    const state = await s.until("terminal.session",
      (value) => value?.selectionReleases > metrics.selectionReleases || value?.error !== undefined,
      "the sidecar did not answer the selection release", { surface });
    assert.equal(state.error, undefined, `the drag reported ${state.error}`);
    const shown = await s.presented();
    const stop = await recording.stop({ after: Math.max(displayed, shown.displayed) + 100 });
    try {
      assert.equal(stop.limited, false, "the recording reached its frame cap");
      const colour = await selectionBackground(s);
      const ends = frames(recording.frames).map(readFrame).map((frame) => {
        const at = (col) => pixel(frame, Math.round((originX + (col + 0.1) * metrics.cellWidth) * frame.scale),
          Math.round((originY + (row + 0.08) * metrics.cellHeight) * frame.scale));
        let end = -1;
        for (let col = 0; col < metrics.cols; col += 1) if (isColor(at(col), colour)) end = col;
        return end;
      });
      assert.ok(ends.length > 0, "the recording has no frames");
      const seen = ends.filter((end) => end !== -1);
      assert.ok(seen.length > 0, `no frame shows the highlight on row ${row}: ${JSON.stringify(ends)}`);
      for (let index = 1; index < seen.length; index += 1) {
        assert.ok(seen[index] >= seen[index - 1], `the highlight moved back between frames: ${JSON.stringify(seen)}`);
      }
      assert.ok(seen.every((end) => end >= START && end <= last), `a frame shows the highlight off the drag: ${JSON.stringify(seen)}`);
      assert.equal(seen.at(-1), last, `the highlight ended away from the cell under the pointer: ${JSON.stringify(seen)}`);
    } finally {
      rmSync(recording.frames, { recursive: true, force: true });
    }
  });
}
