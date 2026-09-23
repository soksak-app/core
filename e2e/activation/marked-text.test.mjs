// 활성화 등급 창 검사: marked text 를 쓰는 macOS 일본어 입력기의 조합이 끝날 때 터미널이 그 문자열을
// PTY 에 정확히 한 번 쓰는지 확인한다(F8-7).
//
// 일본어(로마자) 입력기는 입력한 가나를 marked text 로 두고(실시간 변환이 켜져 있으면 한자로 바꾼다),
// 입력 소스를 바꾸면 조합을 끝낸다. 기대하는 확정 문자열은 입력기가 마지막으로 보고한 marked text 다. 이 검사는
// 앱을 활성화해 사용자 포커스를 가져가고 진단 빌드의 diagnostics.input.source 로 입력 소스를 바꾸며,
// 끝나면 이전 입력 소스를 되돌린다. 입력 소스가 켜져 있지 않으면 실패한다. 사용자가 승인한 실행에서
// pnpm -F @soksak/e2e verify:activation 으로만 실행한다.
import assert from "node:assert/strict";
import test from "node:test";

import { APPS, fresh, open } from "../app.mjs";
import { ensureTerminals, readScreenUntil } from "../terminal-screen.mjs";

const ABC = "com.apple.keylayout.ABC";
const JAPANESE = "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese";

for (const app of Object.values(APPS)) {
  test(`${app.name}: marked text that the input method ends is written to the PTY once`,
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

      await s.run("terminal.ime.trace", { action: "start" }, surface);
      s.cleanup(() => s.run("terminal.ime.trace", { action: "stop" }, surface));

      assert.equal((await s.request("diagnostics.input.source", { select: JAPANESE })).current, JAPANESE,
        `the ${JAPANESE} input source is not enabled`);
      for (const key of ["n", "i", "h", "o", "n", "n"]) await s.press(key);
      // 마지막 n 뒤 marked text 에는 로마자가 남지 않는다.
      const marked = (await s.until("terminal.compose", (compose) => compose.text.length > 0 && !/[a-z]/.test(compose.text),
        "the input method did not show marked text for nihonn", { surface })).text;
      const screen = await s.get("terminal.screen", surface);
      assert.ok(!screen.some((cells) => cells.map((cell) => cell.ch).join("").includes(marked)),
        "marked text reached the PTY before the composition ended");

      // 입력 소스를 바꾸면 입력기가 조합을 끝내고 AppKit 이 marked text 를 확정한다.
      assert.equal((await s.request("diagnostics.input.source", { select: ABC })).current, ABC);
      await s.until("terminal.compose", (compose) => compose.text === "",
        "the ended composition left a preedit", { surface });
      const composing = await s.get("terminal.ime.trace", surface);
      const expected = composing.entries.filter((entry) => entry.kind === "native-compose" && entry.text !== "").at(-1)?.text;
      assert.ok(expected, "the trace has no marked text");
      await readScreenUntil(s, surface, (lines) => lines.some((line) => line.trimEnd().endsWith(expected)),
        `the ended composition did not write ${expected} to the PTY`);
      await s.press("Enter");
      const output = await readScreenUntil(s, surface,
        (lines) => lines.some((line) => line.includes(`${expected}: command not found`)),
        "the shell did not run the committed text");
      const commandRows = output.filter((line) => line.includes(expected));
      assert.ok(commandRows.every((line) => line.split(expected).length === 2),
        `the committed text was repeated: ${JSON.stringify(commandRows)}`);

      const trace = await s.run("terminal.ime.trace", { action: "stop" }, surface);
      const composed = trace.entries.filter((entry) => entry.kind === "native-compose" && entry.text !== "");
      assert.equal(trace.overflow, false, "the IME trace overflowed");
      const inserts = trace.entries.filter((entry) => entry.kind === "native-insert");
      const written = trace.entries.filter((entry) => entry.kind === "terminal-input" && entry.input.type === "insert")
        .map((entry) => entry.input.text);
      t.diagnostic(`${app.name}: marked ${JSON.stringify(composed.map((entry) => entry.text))}, native inserts ${JSON.stringify(inserts.map((entry) => entry.text))}, terminal inserts ${JSON.stringify(written)}`);
      assert.deepEqual(inserts.map((entry) => entry.text), [expected], "the native client did not commit the marked text exactly once");
      assert.deepEqual(written, [expected], "the terminal input queue did not write the marked text exactly once");
      const commit = inserts[0].sequence;
      assert.ok(!trace.entries.some((entry) => entry.kind === "native-compose" && entry.sequence > commit && entry.text !== ""),
        "a preedit followed the commit");
      t.diagnostic(`${app.name}: PASS ${expected} committed once`);
    });
}
