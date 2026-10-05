// main page 를 다시 읽는 동안 native 표면이 페이지 DOM 없이 보이지 않는지 녹화로 잰다(docs/spec/surface-composition.md).
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";
import { MEASURED_BACKGROUND, ensureTerminals, setMeasuredBackground } from "./terminal-screen.mjs";

const near = (a, b, tolerance) => a.every((value, index) => Math.abs(value - b[index]) <= tolerance);

for (const app of Object.values(APPS)) {
  test(`${app.name}: a main-page reload shows no native surface without the page`, { timeout: 120000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    // 터미널 래스터가 칠한 자리만 측정 색이 되게 한다.
    await setMeasuredBackground(s, terminal.surface);
    const grid = await s.get("core.grid");
    const card = grid.cards.find((item) => item.active === terminal.surface);
    assert.ok(card, "no card shows the terminal");
    const surface = (await s.surfaces()).find((item) => item.surface === terminal.surface);
    assert.ok(surface?.applied, "the terminal has no applied native frame");
    // 표면 오른쪽 아래(글자가 없는 칸)와 카드 머리 줄(페이지 DOM)의 한 점을 창 좌표로 잰다.
    const nativePoint = { x: surface.applied.x + surface.applied.w - 12, y: surface.applied.y + surface.applied.h - 12 };
    const pagePoint = { x: grid.plane.x + card.x + card.w / 2, y: grid.plane.y + card.y + 3 };
    const { displayed } = await s.presented();
    const recording = await s.request("diagnostics.capture.start", {});
    try {
      const before = (await s.get("core.window.document")).timeOrigin;
      await s.run("host.window.reload");
      await s.until("core.window.document", (doc) => doc.timeOrigin !== before && doc.readyState === "complete",
        "the main document did not reload");
      await ensureTerminals(s, 1);
      const shown = await s.presented();
      const stop = await s.request("diagnostics.capture.stop", { after: Math.max(displayed, shown.displayed) + 100 });
      assert.equal(stop.limited, false, "the recording reached its frame cap");
      const captured = frames(recording.frames).map(readFrame);
      assert.ok(captured.length > 4, `the recording has ${captured.length} frames`);
      const sample = (frame, point) => {
        const scale = frame.scale * frame.contentScale;
        return pixel(frame, Math.floor(frame.content.x * frame.scale + point.x * scale),
          Math.floor(frame.content.y * frame.scale + point.y * scale));
      };
      // 첫 프레임의 머리 줄 색이 페이지가 그린 색이다. 그 색이 아닌데 표면 자리가 측정 색이면 페이지 없이 표면이 보인 것이다.
      const pageColour = sample(captured[0], pagePoint);
      assert.ok(near(sample(captured[0], nativePoint), MEASURED_BACKGROUND, 3),
        `the first frame does not show the terminal raster at ${JSON.stringify(nativePoint)}: ${sample(captured[0], nativePoint)}`);
      const exposed = captured.map((frame, index) => ({ index, time: frame.time, page: sample(frame, pagePoint), native: sample(frame, nativePoint) }))
        .filter((item) => near(item.native, MEASURED_BACKGROUND, 3) && !near(item.page, pageColour, 12));
      assert.deepEqual(exposed.map(({ index, page, native }) => ({ index, page, native })), [],
        `native terminal frames without the page (page colour ${pageColour}) in ${captured.length} recorded frames`);
      t.diagnostic(`${captured.length} frames, page colour ${pageColour}, gap ${stop.longestGap}ms`);
    } finally {
      rmSync(recording.frames, { recursive: true, force: true });
    }
  });
}
