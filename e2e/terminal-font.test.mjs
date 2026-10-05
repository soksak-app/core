// 터미널 글꼴: font.family 우선순위 목록에서 설치된 첫 family 를 쓰고, 없는 family 는 오류가 아님을 검사한다.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "./fixture.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";
import { ensureTerminals, readScreenUntil } from "./terminal-screen.mjs";

const SETTING = "terminal.font.family";
const DEFAULT = "D2Coding;Menlo";

for (const app of Object.values(APPS)) {
  test(`${app.name}: the terminal applies the first installed family of font.family`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.settings.change", { key: SETTING, value: DEFAULT, scope: "common" }));
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    const initial = await s.until("terminal.session", (session) => typeof session.font === "string" && session.font.length > 0,
      "the terminal did not report an applied font", { surface });
    t.diagnostic(`${app.name}: default list ${DEFAULT} applied ${initial.font}`);

    await s.run("core.settings.change", { key: SETTING, value: "No Such Terminal Font Family;Courier", scope: "common" });
    const courier = await s.until("terminal.session", (session) => session.font === "Courier",
      "the terminal did not skip the missing family and apply Courier", { surface });
    assert.equal(courier.error, undefined, "a missing family in the list is not an error");

    await s.run("core.settings.change", { key: SETTING, value: "No Such Terminal Font Family;Menlo", scope: "common" });
    const menlo = await s.until("terminal.session", (session) => session.font === "Menlo",
      "the terminal did not apply Menlo", { surface });
    t.diagnostic(`${app.name}: cell size Courier ${courier.cellWidth}x${courier.cellHeight}, Menlo ${menlo.cellWidth}x${menlo.cellHeight}`);
    assert.notDeepEqual([menlo.cellWidth, menlo.cellHeight], [courier.cellWidth, courier.cellHeight],
      "a different family changes the cell size");

    await s.run("core.settings.change", { key: SETTING, value: "No Such Terminal Font Family", scope: "common" });
    const system = await s.until("terminal.session", (session) => session.fontSystem === true,
      "the terminal did not use the system fixed-pitch font for a list without installed families", { surface });
    t.diagnostic(`${app.name}: no installed family applied ${system.font}`);
    assert.equal(system.error, undefined, "a list without installed families uses the system fixed-pitch font without an error");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a wide glyph narrower than two cells is centred in them`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    if (!s) return t.skip(`${app.binary} is not built`);
    await fresh(s);
    s.cleanup(() => s.run("core.settings.change", { key: SETTING, value: DEFAULT, scope: "common" }));
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    // Menlo 에는 한글이 없어 대체 글꼴로 그리며, 그 폭은 두 칸보다 좁다.
    await s.run("core.settings.change", { key: SETTING, value: "Menlo", scope: "common" });
    const session = await s.until("terminal.session", (value) => value.font === "Menlo", "the terminal did not apply Menlo", { surface });
    await s.run("terminal.input", { bytes: "clear; printf '\\n한\\n'\r" }, surface);
    const lines = await readScreenUntil(s, surface, (screen) => screen.some((line) => line === "한"), "the Hangul line did not render");
    const row = lines.indexOf("한");

    await s.request("diagnostics.capture.start", {});
    const displayed = await s.presented();
    const { frames: frameDir } = await s.request("diagnostics.capture.stop", { after: displayed.displayed });
    try {
      const files = frames(frameDir);
      assert.ok(files.length > 0, "the capture produced no frames");
      const frame = readFrame(files.at(-1));
      const region = (await s.get("host.window")).regions.find((item) => item.surface === surface && item.name === "view");
      const x0 = Math.round(region.frame.x * frame.scale);
      const y0 = Math.round((region.frame.y + row * session.cellHeight) * frame.scale);
      const span = Math.round(2 * session.cellWidth * frame.scale);
      const height = Math.floor(session.cellHeight * frame.scale);
      const background = pixel(frame, Math.round((region.frame.x + region.frame.width - 3) * frame.scale),
        Math.round((region.frame.y + region.frame.height - 3) * frame.scale));
      const inked = [];
      for (let x = 0; x < span; x++) {
        let ink = false;
        for (let y = 0; y < height && !ink; y++) {
          ink = pixel(frame, x0 + x, y0 + y).some((value, index) => Math.abs(value - background[index]) > 80);
        }
        if (ink) inked.push(x);
      }
      assert.ok(inked.length > 0, `no glyph ink in the two cells at row ${row}`);
      const left = inked[0];
      const right = span - 1 - inked.at(-1);
      t.diagnostic(`${app.name}: Hangul ink ${left} px from the left and ${right} px from the right of ${span} px`);
      assert.ok(Math.abs(left - right) <= 3 * frame.scale,
        `the wide glyph is not centred: ${left} px left and ${right} px right of its ink in ${span} device pixels`);
    } finally {
      rmSync(frameDir, { recursive: true, force: true });
    }
  });
}
