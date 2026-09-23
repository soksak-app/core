// 터미널 글꼴: 기본 글꼴의 한글 폭, font.family 설정 변경, 없는 글꼴의 거부를 검사한다.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, fresh, open } from "./app.mjs";
import { frames, pixel, readFrame } from "./frame.mjs";
import { ensureTerminals, readScreenUntil } from "./terminal-screen.mjs";

const SETTING = "terminal.font.family";

// row 행 col 칸에서 시작하는 넓은 글자의 잉크가 끝나는 위치를 셀 폭 단위로 잰다. 창을 앞으로 가져오지 않는다.
async function wideGlyphExtent(s, surface, row, col) {
  await s.request("diagnostics.capture.start", {});
  const displayed = await s.presented();
  const { frames: directory } = await s.request("diagnostics.capture.stop", { after: displayed.displayed });
  try {
    const files = frames(directory);
    assert.ok(files.length > 0, "the font capture produced no frames");
    const frame = readFrame(files.at(-1));
    const region = (await s.get("host.window")).regions.find((item) => item.surface === surface && item.name === "view");
    assert.ok(region?.frame, `native terminal region ${surface} has no frame`);
    const state = await s.get("terminal.session", surface);
    const background = pixel(frame, Math.round((region.frame.x + region.frame.width - 2) * frame.scale),
      Math.round((region.frame.y + region.frame.height - 2) * frame.scale));
    const x0 = Math.round((region.frame.x + col * state.cellWidth) * frame.scale);
    const y0 = Math.round((region.frame.y + row * state.cellHeight) * frame.scale);
    const width = Math.floor(2 * state.cellWidth * frame.scale);
    const height = Math.floor(state.cellHeight * frame.scale);
    let right = -1;
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const value = pixel(frame, x0 + x, y0 + y);
        if (value.some((channel, index) => Math.abs(channel - background[index]) > 60)) right = x;
      }
    }
    return { cells: (right + 1) / (state.cellWidth * frame.scale), cellWidth: state.cellWidth };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the terminal draws Hangul with its monospace default font and follows font.family`,
    { timeout: 60000 }, async (t) => {
      const s = await open(t, app);
      if (!s) return t.skip(`${app.binary} is not built`);
      await fresh(s);
      s.cleanup(() => s.run("core.settings.change", { key: SETTING, value: "D2Coding", scope: "common" }));
      const [terminal] = await ensureTerminals(s, 1);
      const surface = terminal.surface;
      await s.until("terminal.session", (session) => session.font === "D2Coding",
        "the terminal did not report the bundled default font", { surface });

      await s.run("terminal.input", { bytes: "printf '\\n한글\\n'\r" }, surface);
      const lines = await readScreenUntil(s, surface, (rows) => rows.includes("한글"), "the Hangul line did not appear");
      const row = lines.indexOf("한글");
      const d2 = await wideGlyphExtent(s, surface, row, 0);
      t.diagnostic(`${app.name}: D2Coding 한 ink extent ${JSON.stringify(d2)}`);
      assert.ok(d2.cells >= 1.75 && d2.cells <= 2, `the default font must draw 한 across two cells: ${JSON.stringify(d2)}`);

      await s.run("core.settings.change", { key: SETTING, value: "Menlo", scope: "common" });
      const menlo = await s.until("terminal.session", (session) => session.font === "Menlo",
        "the terminal did not apply Menlo", { surface });
      t.diagnostic(`${app.name}: cell width D2Coding ${d2.cellWidth}, Menlo ${menlo.cellWidth}`);
      assert.notEqual(menlo.cellWidth, d2.cellWidth, "a different family changes the cell width");

      await s.run("core.settings.change", { key: SETTING, value: "No Such Terminal Font Family", scope: "common" });
      const rejected = await s.until("terminal.session", (session) => /not installed/.test(session.error ?? ""),
        "a missing family was not reported", { surface });
      assert.equal(rejected.font, "Menlo", "a missing family does not replace the applied font");

      // 설치된 글꼴로 되돌리면 글꼴 오류가 해제된다.
      await s.run("core.settings.change", { key: SETTING, value: "D2Coding", scope: "common" });
      await s.until("terminal.session", (session) => session.font === "D2Coding" && session.error === undefined,
        "restoring an installed family did not clear the font error", { surface });
    });
}
