// 활성화 등급 창 검사: 실제 macOS 입력기로 터미널에 한글을 입력한다.
//
// OS 입력기는 활성 애플리케이션의 키 창만 처리하므로 이 검사는 앱을 활성화해 사용자 포커스를
// 가져가고, 진단 빌드의 diagnostics.input.source 로 입력 소스를 바꾼다. 끝나면 이전 입력 소스를
// 되돌린다. 기본 창 검사(pnpm -F @soksak/e2e verify)에 포함하지 않고, 사용자가 승인한 실행에서
// pnpm -F @soksak/e2e verify:activation 으로만 실행한다.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, fresh, open } from "../app.mjs";
import { frames, pixel, readFrame } from "../frame.mjs";
import { ensureTerminals, readScreenUntil } from "../terminal-screen.mjs";

const ABC = "com.apple.keylayout.ABC";
const KOREAN_2SET = "com.apple.inputmethod.Korean.2SetKorean";

// 커서 칸과 그 오른쪽 칸에서 표면 배경과 다른 픽셀의 비율을 잰다. 캡처는 창을 앞으로 가져오지 않는다.
async function cursorCellCoverage(s, surface) {
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
    return { cursor, first: coverage(cursor.col), second: coverage(cursor.col + 1) };
  } finally {
    rmSync(frameDir, { recursive: true, force: true });
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a Korean syllable typed right after an input-source switch reaches the PTY once`,
    { timeout: 60000 }, async (t) => {
      const s = await open(t, app);
      assert.ok(s, `${app.binary} is not built`);
      await fresh(s);
      const [terminal] = await ensureTerminals(s, 1);
      const surface = terminal.surface;
      await readScreenUntil(s, surface, (lines) => lines.some((line) => /[$%#>]$/.test(line)),
        "the shell prompt did not appear");

      const original = (await s.request("diagnostics.input.source")).current;
      s.cleanup(() => s.request("diagnostics.input.source", { select: original }));

      const view = await s.rect("terminal.view", undefined, surface);
      const x = view.document.x + view.x + view.width / 2;
      const y = view.document.y + view.y + view.height / 2;
      await s.pointer(x, y, "move", { activate: true });
      await s.click(x, y);
      await s.until("host.window", (host) => host.active === true &&
        host.regions.some((region) => region.surface === surface && region.focused),
      "the terminal did not receive native focus in the active window");

      // 사용자 보고 순서: 영문 자판으로 ddd, 한국어 2벌식으로 바꿔 한글(g k s r m f), Space, Enter.
      assert.equal((await s.request("diagnostics.input.source", { select: ABC })).current, ABC);
      for (const typed of ["d", "dd", "ddd"]) {
        await s.press("d");
        await readScreenUntil(s, surface, (lines) => lines.some((line) => line.endsWith(typed)),
          `the ABC key did not produce ${typed}`);
      }
      assert.equal((await s.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET);

      const steps = [["g", "ㅎ"], ["k", "하"], ["s", "한"], ["r", "ㄱ"], ["m", "그"], ["f", "글"], ["Space", " "]];
      for (const [key, preedit] of steps) {
        await s.press(key);
        await s.until("terminal.compose", (compose) => compose.text === preedit,
          `the ${key} key did not show the ${JSON.stringify(preedit)} preedit`, { surface });
        if (preedit === "글") {
          // 넓은 조합 글자는 커서가 두 칸을 모두 덮는다.
          const measured = await cursorCellCoverage(s, surface);
          t.diagnostic(`${app.name}: preedit 글 cursor coverage ${JSON.stringify(measured)}`);
          assert.ok(measured.first > 0.5 && measured.second > 0.5,
            `the block cursor does not cover the wide preedit: ${JSON.stringify(measured)}`);
        }
      }
      const typed = await readScreenUntil(s, surface, (lines) => lines.some((line) => line.endsWith("ddd한글")),
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
      t.diagnostic(`${app.name}: PASS ddd한글 after an input-source switch`);
    });
}
