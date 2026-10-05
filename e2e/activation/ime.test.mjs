// 활성화 등급 창 검사: 실제 macOS 입력기로 터미널에 한글을 입력한다.
//
// OS 입력기는 활성 애플리케이션의 키 창만 처리하므로 이 검사는 앱을 활성화해 사용자 포커스를
// 가져가고, 진단 빌드의 diagnostics.input.source 로 입력 소스를 바꾼다. 끝나면 이전 입력 소스를
// 되돌린다. 기본 창 검사(pnpm -F @soksak/e2e verify)에 포함하지 않고, 사용자가 승인한 실행에서
// pnpm -F @soksak/e2e verify:activation 으로만 실행한다.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, open } from "@soksak/window-check/app.mjs";
import { fresh } from "../fixture.mjs";
import { frames, pixel, readFrame } from "@soksak/window-check/frame.mjs";
import { ensureTerminals, readScreenUntil } from "../terminal-screen.mjs";

const ABC = "com.apple.keylayout.ABC";
const KOREAN_2SET = "com.apple.inputmethod.Korean.2SetKorean";

// 커서 칸과 그 오른쪽 칸에서 표면 배경과 다른 픽셀의 비율을 잰다. 캡처는 창을 앞으로 가져오지 않는다.
async function cursorCellCoverage(s, surface, offset = 0) {
  // screen.read 응답이 현재 커서를 terminal.cursor 에 반영한다.
  await s.run("terminal.screen.read", {}, surface);
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
    // 블록 커서 아래의 글자 획은 반전되어 어둡다. 둘째 칸의 어두운 픽셀 비율은 글자 오른쪽 절반의 잉크다.
    const darkInCell = (col) => {
      const x0 = Math.round((region.frame.x + col * state.cellWidth) * frame.scale);
      const y0 = Math.round((region.frame.y + cursor.row * state.cellHeight) * frame.scale);
      let dark = 0;
      let total = 0;
      for (let y = y0; y < y0 + Math.floor(state.cellHeight * frame.scale); y++) {
        for (let x = x0; x < x0 + Math.floor(state.cellWidth * frame.scale); x++) {
          const [r, g, b] = pixel(frame, x, y);
          total++;
          if (0.299 * r + 0.587 * g + 0.114 * b < 100) dark++;
        }
      }
      return dark / total;
    };
    return {
      cursor,
      first: coverage(cursor.col + offset),
      second: coverage(cursor.col + offset + 1),
      preeditSecond: coverage(cursor.col + Math.max(offset - 1, 1)),
      secondInk: darkInCell(cursor.col + Math.max(offset - 1, 1)),
    };
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

      // 키 창은 포인터 위치를 이동으로 받으므로 창을 포인터 밖에 둔다.
      await s.keepPointerOutside();
      const view = await s.rect("terminal.view", undefined, surface);
      const x = view.document.x + view.x + view.width / 2;
      const y = view.document.y + view.y + view.height / 2;
      await s.pointer(x, y, "move", { activate: true });
      await s.click(x, y);
      await s.until("host.window", (host) => host.active === true &&
        host.regions.some((region) => region.surface === surface && region.focused),
      "the terminal did not receive native focus in the active window");

      // 네이티브 콜백과 PTY 입력 대기열을 기록한다. 결과는 아래에서 순서와 횟수로 검사한다.
      await s.run("terminal.ime.trace", { action: "start" }, surface);
      s.cleanup(() => s.run("terminal.ime.trace", { action: "stop" }, surface));

      // 사용자 보고 순서: 영문 자판으로 ddd, 한국어 2벌식으로 바꿔 한글(g k s r m f), Space, Enter.
      assert.equal((await s.request("diagnostics.input.source", { select: ABC })).current, ABC);
      for (const typed of ["d", "dd", "ddd"]) {
        await s.press("d");
        await readScreenUntil(s, surface, (lines) => lines.some((line) => line.endsWith(typed)),
          `the ABC key did not produce ${typed}`);
      }
      // 좁은 글자 뒤의 빈 칸에서는 커서가 한 칸만 덮는다.
      const narrow = await cursorCellCoverage(s, surface);
      t.diagnostic(`${app.name}: narrow cursor coverage ${JSON.stringify({ col: narrow.cursor.col, first: narrow.first, second: narrow.second })}`);
      assert.ok(narrow.first > 0.9 && narrow.second < 0.1,
        `the cursor after ASCII text must cover exactly one cell: ${JSON.stringify(narrow)}`);
      assert.equal((await s.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET);

      const steps = [["g", "ㅎ"], ["k", "하"], ["s", "한"], ["r", "ㄱ"], ["m", "그"], ["f", "글"]];
      let preeditCursor;
      let preeditWidth;
      for (const [key, preedit] of steps) {
        await s.press(key);
        const compose = await s.until("terminal.compose", (value) => value.text === preedit ||
          (value.text === `한${preedit}` && ["ㄱ", "그", "글"].includes(preedit)),
          `the ${key} key did not show the ${JSON.stringify(preedit)} preedit`, { surface });
        if (preedit === "글") {
          // 선택 범위가 글 뒤를 가리키므로 커서는 조합 글자 다음 칸에 그린다.
          assert.equal(compose.selectedRange?.location, compose.text.length,
            "the input method did not select the end of the preedit");
          preeditWidth = compose.text.length * 2;
          const measured = await cursorCellCoverage(s, surface, preeditWidth);
          preeditCursor = measured.cursor;
          t.diagnostic(`${app.name}: preedit 글 cursor coverage ${JSON.stringify(measured)}`);
          assert.ok(measured.first > 0.9 && measured.second < 0.1,
            `the block cursor is not after the wide preedit: ${JSON.stringify(measured)}`);
          // 넓은 조합 글자의 오른쪽 절반도 그려진다.
          assert.ok(measured.preeditSecond > 0.02,
            `the right half of the wide preedit glyph is missing: ${JSON.stringify(measured)}`);
        }
      }
      // F8-16: Space 는 입력기가 처리하지 않는 키이므로 글과 공백이 다음 키 없이 PTY 에 도착한다.
      // 셸이 남은 조합 문자열과 공백을 반향하면 커서가 그 표시 폭만큼 이동한다.
      await s.press("Space");
      await s.until("terminal.compose", (compose) => compose.text === "",
        "the Space key left a preedit", { surface });
      const spaced = await s.until("terminal.cursor", (cursor) => cursor.row === preeditCursor.row &&
        cursor.col === preeditCursor.col + preeditWidth + 1,
        `the space after 글 did not reach the PTY before any further key (preedit cursor ${JSON.stringify(preeditCursor)})`, { surface });
      t.diagnostic(`${app.name}: cursor after Space ${JSON.stringify(spaced)} from preedit cursor ${JSON.stringify(preeditCursor)}`);
      const typed = await readScreenUntil(s, surface, (lines) => lines.some((line) => line.trimEnd().endsWith("ddd한글")),
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

      // 같은 세션에서 이어서 조합한 음절도 한 번씩 순서대로 PTY 에 도착한다.
      for (const key of ["g", "k", "s", "Space"]) await s.press(key);
      await s.until("terminal.compose", (compose) => compose.text === "", "the second syllable left a preedit", { surface });
      await s.press("Enter");
      const second = await readScreenUntil(s, surface, (lines) => lines.some((line) => /한: command not found/.test(line)),
        "the shell did not run the second committed command");
      assert.ok(!second.some((line) => /[ㄱ-ㅣ]/.test(line)), `jamo reached the PTY: ${JSON.stringify(second)}`);

      // F8-16-1: 음절 뒤 숫자도 다음 키 없이 PTY 에 도착한다.
      for (const key of ["g", "k", "s", "1"]) await s.press(key);
      await s.until("terminal.compose", (compose) => compose.text === "", "the digit after a syllable left a preedit", { surface });
      await readScreenUntil(s, surface, (lines) => lines.some((line) => line.trimEnd().endsWith("한1")),
        "the digit after a syllable did not reach the PTY before any further key");
      await s.press("Enter");
      await readScreenUntil(s, surface, (lines) => lines.some((line) => /한1: command not found/.test(line)),
        "the shell did not run the command with the digit");

      // F8-20: 조합 중 Backspace 는 입력기가 음절을 편집하고(한 → 하) PTY 에는 최종 음절만 도착한다.
      for (const key of ["g", "k", "s", "Backspace"]) await s.press(key);
      await s.until("terminal.compose", (compose) => compose.text === "하", "Backspace did not edit the composition to 하", { surface });
      await s.press("Enter");
      try {
        await readScreenUntil(s, surface, (lines) => lines.some((line) => /하: command not found/.test(line)),
          "the shell did not run the edited syllable");
      } catch (error) {
        const trace = await s.run("terminal.ime.trace", { action: "stop" }, surface);
        error.message += `; input trace ${JSON.stringify(trace.entries)}`;
        throw error;
      }

      const trace = await s.run("terminal.ime.trace", { action: "stop" }, surface);
      assert.equal(trace.overflow, false, "the IME trace overflowed");
      const inserts = trace.entries.filter((entry) => entry.kind === "native-insert").map((entry) => entry.text).join("");
      const written = trace.entries.filter((entry) => entry.kind === "terminal-input" && entry.input.type === "insert")
        .map((entry) => entry.input.text).join("");
      const composed = trace.entries.filter((entry) => entry.kind === "native-compose" && entry.text !== "").map((entry) => entry.text);
      t.diagnostic(`${app.name}: native inserts ${JSON.stringify(inserts)}, terminal inserts ${JSON.stringify(written)}, preedit ${JSON.stringify(composed)}`);
      assert.equal(inserts, "ddd한글 한 한1하", "the native client did not commit each syllable exactly once in order");
      assert.equal(written, "ddd한글 한 한1하", "the terminal input queue did not receive each committed syllable exactly once in order");
      assert.deepEqual(composed.slice(0, 3), ["ㅎ", "하", "한"], "the first syllable did not compose in order");
      for (const [index, suffix] of [[3, "ㄱ"], [4, "그"], [5, "글"]]) {
        assert.ok([suffix, `한${suffix}`].includes(composed[index]),
          `the second syllable did not compose in order: ${JSON.stringify(composed.slice(0, 6))}`);
      }
      assert.ok(!trace.entries.some((entry) => entry.kind === "native-key" && entry.key === "Backspace"),
        "Backspace during a composition reached the terminal as a key");
      const enters = trace.entries.filter((entry) =>
        (entry.kind === "native-key" && entry.key === "Enter") ||
        (entry.kind === "terminal-input" && entry.input?.type === "command" && entry.input.selector === "insertNewline:"))
        .map((entry) => entry.sequence);
      const lastInsert = trace.entries.filter((entry) => entry.kind === "native-insert").at(-1).sequence;
      assert.equal(enters.length, 4, "four Enter actions were not traced");
      assert.ok(enters[3] > lastInsert, "Enter was delivered before the committed text");
      t.diagnostic(`${app.name}: PASS ddd한글 after an input-source switch`);
    });

  test(`${app.name}: the cursor follows the selected end of Korean preedit`, { timeout: 60000 }, async (t) => {
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const [terminal] = await ensureTerminals(s, 1);
    const surface = terminal.surface;
    const original = (await s.request("diagnostics.input.source")).current;
    s.cleanup(() => s.request("diagnostics.input.source", { select: original }));
    await s.keepPointerOutside();
    const view = await s.rect("terminal.view", undefined, surface);
    const x = view.document.x + view.x + view.width / 2;
    const y = view.document.y + view.y + view.height / 2;
    await s.pointer(x, y, "move", { activate: true });
    await s.click(x, y);
    await s.until("host.window", (host) => host.active === true &&
      host.regions.some((region) => region.surface === surface && region.focused),
    "the terminal did not receive native focus in the active window");
    assert.equal((await s.request("diagnostics.input.source", { select: ABC })).current, ABC);
    for (const key of "ddd") await s.press(key);
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.endsWith("ddd")),
      "ASCII input did not reach the PTY before Korean input");
    assert.equal((await s.request("diagnostics.input.source", { select: KOREAN_2SET })).current, KOREAN_2SET);
    await s.run("terminal.ime.trace", { action: "start" }, surface);
    s.cleanup(() => s.run("terminal.ime.trace", { action: "stop" }, surface));
    for (const key of ["g", "k", "s", "r", "m", "f", "d", "m", "s"]) await s.press(key);
    const compose = await s.until("terminal.compose", (value) => value.text.endsWith("은") &&
      value.selectedRange?.location === value.text.length,
    "Korean preedit did not reach its selected end", { surface });
    assert.match(compose.text, /^[가-힣]+$/, "the preedit contains input other than Hangul syllables");
    const measured = await cursorCellCoverage(s, surface, compose.text.length * 2);
    t.diagnostic(`${app.name}: preedit ${compose.text} selected end coverage ${JSON.stringify(measured)}`);
    assert.ok(measured.first > 0.9 && measured.second < 0.1,
      `the cursor is not after the selected Korean preedit: ${JSON.stringify(measured)}`);
    await s.press("Space");
    try {
      await s.until("terminal.compose", (value) => value.text === "", "Space did not commit the preedit", { surface });
    } catch (error) {
      const trace = await s.run("terminal.ime.trace", { action: "stop" }, surface);
      error.message += `; input trace ${JSON.stringify(trace.entries)}`;
      throw error;
    }
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.trimEnd().endsWith("ddd한글은")),
      "committed Korean text did not reach the PTY before another key");
  });
}
