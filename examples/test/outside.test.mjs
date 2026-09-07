// 250pt를 400ms에 이동하는 두 왕복을 녹화해 표면의 카드 내부 표시를 검사한다.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import { APPS, ask, nativeProbe, nothingRecorded, shakeTwice } from "./app.mjs";
import { frames, readFrame, writePNG } from "./frame.mjs";
import { outside } from "./outside.mjs";
import { alignment } from "./alignment.mjs";

const DRIVE = "5000,x,2,-250,0,400,2";

const READ = 0.5;

function assertAligned(name, run) {
  let keep = false;
  try {
    assert.ok(
      !nothingRecorded(run.log),
      `the window server delivered no frames, so nothing was measured:\n${run.log}`,
    );
    const files = frames(run.into);
    assert.ok(files.length > 30, `only ${files.length} frames were recorded:\n${run.log}`);

    let worst = { out: 0, path: "", at: null };
    let read = 0;
    let broke = 0;
    const positions = [];
    let initial = null;
    let delayed = { delta: 0, path: "", geometry: null };
    for (const path of files) {
      const frame = readFrame(path);
      const at = outside(frame);
      if (!at) continue;
      const geometry = alignment(frame, at);
      assert.ok(geometry, `the terminal line, sidebar, or rail could not be measured in ${path}`);
      initial ??= geometry;
      const delta = Math.max(...Object.keys(initial).map((key) => Math.abs(geometry[key] - initial[key])));
      if (delta > delayed.delta) delayed = { delta, path, geometry };
      read++;
      positions.push(at.card.l / at.scale);
      if (at.out <= 0) continue;
      broke++;
      if (at.out > worst.out) worst = { out: at.out, path, at };
    }
    assert.ok(
      read > files.length * READ,
      `only ${read} of ${files.length} frames could be measured, so this run checked ` +
        `nothing. The surface or its card was not found in the rest.\n${run.log}`,
    );

    const low = Math.min(...positions), high = Math.max(...positions);
    const span = high - low;
    assert.ok(span >= 50, `the card moved only ${span}pt; the requested drag was not recorded`);
    const ends = [];
    for (const position of positions) {
      const end = position <= low + span * .2 ? "low" : position >= high - span * .2 ? "high" : null;
      if (end && ends.at(-1) !== end) ends.push(end);
    }
    assert.deepEqual(ends, ["high", "low", "high", "low", "high"],
      "the recording must contain both complete round trips");
    assert.ok(Math.abs(positions[0] - positions.at(-1)) <= 1,
      "the recorded card must return to its initial position");

    if (delayed.delta > 1) {
      const shown = join(process.cwd(), `${name}-alignment.png`);
      writePNG(readFrame(delayed.path), shown);
      assert.fail(`native content, card, sidebar, and rail geometry differ by ${delayed.delta.toFixed(1)}pt: ` +
        `initial ${JSON.stringify(initial)}, frame ${JSON.stringify(delayed.geometry)}; ${shown}; ${run.into}`);
    }

    if (broke > 0) {
      keep = true;
      const shown = join(process.cwd(), `${name}-outside.png`);
      writePNG(readFrame(worst.path), shown);
      const { at } = worst;
      assert.fail(
        `${broke} of ${read} measured frames draw the surface outside its own card. ` +
          `The worst is ${worst.out.toFixed(1)}pt out` +
          (at.onNeighbour > 0
            ? `, ${at.onNeighbour.toFixed(1)}pt of it over the neighbouring card`
            : "") +
          `: the card spans ${at.card.l}..${at.card.r} and the surface ${at.surface.l}..` +
          `${at.surface.r} on row ${at.row}, at ${at.scale} pixels to the point. ` +
          `That frame is written to ${shown}, and the run's frames are kept in ${run.into}.`,
      );
    }
  } catch (error) {
    keep = true;
    error.message += `\nRecorded frames: ${run.into}`;
    throw error;
  } finally {
    if (!keep) run.clean();
  }
}

for (const [name, binary] of Object.entries(APPS)) {
  test(`${name}: native content, cards, and the sidebar rail stay aligned`, async (t) => {
    const run = await shakeTwice(binary, DRIVE);
    if (!run) return t.skip(`${binary} is not built`);
    assertAligned(name, run);
  });

  test(`${name}: an external document's busy script does not stop the main layout`, async (t) => {
    const loaded = await ask(binary, 'transcript on', (text) => text.includes('observe: transcript on'));
    if (!loaded) return t.skip(`${binary} is not built`);
    const until = Date.now() + 10_000;
    for (;;) {
      const state = await nativeProbe(binary, { op: "eval", match: "https:",
        script: "[location.href, document.readyState]" });
      if (state[0] !== "about:blank" && state[1] === "complete") break;
      assert.ok(Date.now() < until, "the external document did not load");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await nativeProbe(binary, { op: "eval", match: "main", script: `
      window.__layoutProgress = [];
      let previous = "";
      window.__layoutObserver = new MutationObserver(() => {
        const rects = JSON.stringify([...document.querySelectorAll("[data-card-id]")]
          .map((card) => [card.dataset.cardId, card.style.left, card.style.width]));
        if (rects === previous) return;
        previous = rects;
        window.__layoutProgress.push({ at: Date.now(), rects });
      });
      window.__layoutObserver.observe(document.body,
        { subtree: true, attributes: true, attributeFilter: ["style"] });
      null;
    ` });
    let run;
    try {
      run = await shakeTwice(binary, "5000,x,2,-80,0,400,2", {
        from: false,
        before: ['native ' + JSON.stringify({ op: "eval", match: "https:", script: `
          delete window.__busyWork;
          setTimeout(() => {
            window.__busyWork = { began: Date.now() };
            const began = performance.now();
            while (performance.now() - began < 700) {}
            window.__busyWork.elapsed = performance.now() - began;
            window.__busyWork.ended = Date.now();
          }, 200);
          null;
        ` })],
      });
    } finally {
      await nativeProbe(binary, { op: "eval", match: "main",
        script: "window.__layoutObserver.disconnect(); null" });
    }
    const busy = await nativeProbe(binary, { op: "eval", match: "https:", script: "window.__busyWork" });
    assert.ok(busy?.elapsed >= 700, "the external document must execute the 700ms task");
    const changes = await nativeProbe(binary, { op: "eval", match: "main", script: "window.__layoutProgress" });
    const during = changes.filter(({ at }) => at > busy.began && at < busy.ended);
    assert.ok(new Set(during.map(({ rects }) => rects)).size >= 3,
      "the main layout must change repeatedly while the external task is running");
    assertAligned(name, run);
  });
}
