// 활성화 등급 창 검사: 실제 macOS 입력기로 터미널에 한글을 입력한다.
//
// OS 입력기는 활성 애플리케이션의 키 창만 처리하므로 이 검사는 앱을 활성화해 사용자 포커스를
// 가져가고, 진단 빌드의 diagnostics.input.source 로 입력 소스를 바꾼다. 끝나면 이전 입력 소스를
// 되돌린다. 기본 창 검사(pnpm -F @soksak/e2e verify)에 포함하지 않고, 사용자가 승인한 실행에서
// pnpm -F @soksak/e2e verify:activation 으로만 실행한다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, fresh, open } from "../app.mjs";
import { ensureTerminals, readScreenUntil } from "../terminal-screen.mjs";

const ABC = "com.apple.keylayout.ABC";
const KOREAN_2SET = "com.apple.inputmethod.Korean.2SetKorean";

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
