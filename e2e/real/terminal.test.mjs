// 실제 입력 등급 터미널 검사: 사람의 마우스와 키보드가 지나는 경로(창 서버, 키 창, 메뉴 키 대응)로 터미널
// 선택, 복사, 붙여넣기, 휠을 검사한다. 사용자가 승인한 실행에서 pnpm -F @soksak/e2e verify:real 로만 실행한다.
import assert from "node:assert/strict";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, fresh, open } from "../app.mjs";
import { frames, pixel, readFrame } from "../frame.mjs";
import { ensureTerminals, readScreenUntil } from "../terminal-screen.mjs";
import { activateFinder, bringFront, click, dragPath, key, KEYS, keepPasteboard, pasteboardText, post, requireTrusted, screenCenter, systemCursor, writePasteboard } from "./hid.mjs";

// 터미널 한 칸의 중심 화면 좌표.
function cellPoint(origin, session, column, row) {
  return { x: origin.x + (column + 0.5) * session.cellWidth, y: origin.y + (row + 0.5) * session.cellHeight };
}

// 표시된 마지막 화면에서 한 칸 중심의 픽셀을 읽는다.
async function cellPixel(s, surface, session, column, row) {
  await s.request("diagnostics.capture.start", {});
  const displayed = await s.presented();
  const { frames: directory } = await s.request("diagnostics.capture.stop", { after: displayed.displayed });
  try {
    const files = frames(directory);
    assert.ok(files.length > 0, "the capture produced no frames");
    const frame = readFrame(files.at(-1));
    const region = (await s.get("host.window")).regions.find((item) => item.surface === surface && item.name === "view");
    return pixel(frame, Math.round((region.frame.x + (column + 0.5) * session.cellWidth) * frame.scale),
      Math.round((region.frame.y + (row + 0.5) * session.cellHeight) * frame.scale));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// 터미널에 한 줄을 쓰고, 그 줄의 행과 화면 원점을 돌려준다. 검사는 창을 앞으로 가져온 뒤 실제 입력을 보낸다.
async function prepare(t, app, line) {
  requireTrusted();
  const s = await open(t, app);
  assert.ok(s, `${app.binary} is not built`);
  await fresh(s);
  keepPasteboard(s);
  const [terminal] = await ensureTerminals(s, 1);
  const surface = terminal.surface;
  await s.run("terminal.input", { bytes: `clear; printf '${line}\\n'\r` }, surface);
  const lines = await readScreenUntil(s, surface, (screen) => screen.includes(line), `${line} did not render`);
  const session = await s.get("terminal.session", surface);
  const view = await s.rect("terminal.view", undefined, surface);
  const center = await bringFront(s, app, view);
  const origin = { x: center.x - view.width / 2, y: center.y - view.height / 2 };
  return { s, surface, session, origin, row: lines.indexOf(line) };
}

/** Command+V 부터 붙여넣은 텍스트가 화면에 나오기까지의 한도(ms). */
const PASTE_LIMIT = 500;

const same = (a, b) => a.every((value, index) => Math.abs(value - b[index]) <= 8);

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real click clears a terminal selection`, { timeout: 90000 }, async (t) => {
    const { s, surface, session, origin, row } = await prepare(t, app, "SELECTME");
    const blank = 10;
    const background = await cellPixel(s, surface, session, blank, row);

    const before = (await s.get("terminal.session", surface)).selectionReleases;
    dragPath(cellPoint(origin, session, 0, row), cellPoint(origin, session, blank + 2, row));
    await s.until("terminal.session", (value) => value.selectionReleases === before + 1,
      "the sidecar did not answer the release of a real drag", { surface });
    const selected = await cellPixel(s, surface, session, blank, row);
    assert.ok(!same(selected, background), `the drag did not render a selection: ${selected} against ${background}`);

    click(cellPoint(origin, session, 30, row + 3).x, cellPoint(origin, session, 30, row + 3).y);
    await s.until("terminal.session", (value) => value.selectionReleases === before + 2,
      "the sidecar did not answer the release of a real click after a selection", { surface });
    const cleared = await cellPixel(s, surface, session, blank, row);
    assert.ok(same(cleared, background), `a click left the selection rendered: ${cleared} against ${background}`);
    assert.equal(pasteboardText(), "SELECTME", "the click changed the copied selection");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real click gives native focus to the clicked terminal and its card`, { timeout: 90000 }, async (t) => {
    requireTrusted();
    const s = await open(t, app);
    assert.ok(s, `${app.binary} is not built`);
    await fresh(s);
    const terminals = await ensureTerminals(s, 3);
    await s.presented();
    await bringFront(s, app, await s.rect("terminal.view", undefined, terminals[0].surface));
    for (const terminal of [...terminals, terminals[0]]) {
      const point = await screenCenter(s, await s.rect("terminal.view", undefined, terminal.surface));
      click(point.x, point.y);
      await s.until("core.grid", (grid) => grid.cards.some((card) => card.focused &&
        card.tabs.some((tab) => tab.id === terminal.surface)), `the card of ${terminal.surface} did not take focus`);
      const host = await s.until("host.window", (window) => window.responder?.surface === terminal.surface,
        `${terminal.surface} did not become the native first responder after a real click`);
      assert.deepEqual(host.regions.filter((region) => region.focused).map((region) => region.surface), [terminal.surface]);
    }
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real Command+V pastes the clipboard text without another key`, { timeout: 90000 }, async (t) => {
    const { s, surface, origin, session, row } = await prepare(t, app, "PASTEHERE");
    const point = cellPoint(origin, session, 0, row + 1);
    click(point.x, point.y);
    await s.until("host.window", (window) => window.responder?.surface === surface, "the terminal did not take native focus");
    const marker = `PASTED${process.pid}`;
    writePasteboard([{ "public.utf8-plain-text": Buffer.from(marker).toString("base64") }]);
    const started = performance.now();
    key(KEYS.v, ["command"]);
    // key 는 osascript 를 시작해 이벤트를 보내고 돌아온다. 키가 보내진 시각은 started 와 posted 사이다.
    const posted = performance.now();
    // 다른 키 없이 붙여넣은 텍스트가 화면에 나와야 한다. 입력기 문서에 남으면 다음 키까지 나오지 않는다.
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.includes(marker)),
      "Command+V did not paste the clipboard text without another key");
    const elapsed = performance.now() - started;
    t.diagnostic(`${app.name}: Command+V text shown ${elapsed.toFixed(0)} ms after the post started and ` +
      `${(performance.now() - posted).toFixed(0)} ms after it returned`);
    // 입력기 문서에 머문 텍스트는 다른 계기로 확정될 때까지 몇 초 동안 나오지 않았다(V5-42).
    assert.ok(elapsed <= PASTE_LIMIT, `Command+V text appeared ${elapsed.toFixed(0)} ms after the key (limit ${PASTE_LIMIT} ms)`);
    assert.equal((await s.get("terminal.session", surface)).error, undefined);
  });
}

// 1x1 PNG. 붙여넣으면 설정 디렉터리의 clipboard 폴더에 소유 파일로 저장된다.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real Command+V pastes a clipboard image as a quoted owned path`, { timeout: 90000 }, async (t) => {
    const { s, surface, origin, session, row } = await prepare(t, app, "IMAGEHERE");
    const point = cellPoint(origin, session, 0, row + 1);
    click(point.x, point.y);
    await s.until("host.window", (window) => window.responder?.surface === surface, "the terminal did not take native focus");
    writePasteboard([{ "public.png": PNG.toString("base64") }]);
    key(KEYS.v, ["command"]);
    // 긴 경로는 터미널 폭에서 줄바꿈되므로 줄을 이어 읽는다.
    const quoted = /'([^']*\/pasted-image-[^'/]*\.png)'/;
    const lines = await readScreenUntil(s, surface, (screen) => quoted.test(screen.join("")),
      "Command+V did not paste the clipboard image as a quoted path");
    const saved = quoted.exec(lines.join(""))[1];
    s.cleanup(() => rmSync(saved, { force: true }));
    assert.equal(dirname(saved), join(realpathSync(app.configDir), "clipboard"), `the image is not owned by the configuration: ${saved}`);
    assert.deepEqual(readFileSync(saved), PNG, "the saved image differs from the clipboard PNG");
    assert.equal((await s.get("terminal.session", surface)).error, undefined);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real drag copies the selection and Command+C copies it again`, { timeout: 90000 }, async (t) => {
    const { s, surface, session, origin, row } = await prepare(t, app, "COPYME");
    writePasteboard([{ "public.utf8-plain-text": Buffer.from("BEFORE-COPY").toString("base64") }]);
    const before = (await s.get("terminal.session", surface)).selectionReleases;
    dragPath(cellPoint(origin, session, 0, row), cellPoint(origin, session, 5, row));
    await s.until("terminal.session", (value) => value.selectionReleases === before + 1,
      "the sidecar did not answer the release of a real drag", { surface });
    await s.until("terminal.session", () => pasteboardText() === "COPYME",
      `the drag selection did not reach the general pasteboard (it holds ${JSON.stringify(pasteboardText())})`, { surface });
    // 다른 애플리케이션이 클립보드를 바꾼 뒤 Command+C 는 선택을 다시 복사한다.
    writePasteboard([{ "public.utf8-plain-text": Buffer.from("CHANGED").toString("base64") }]);
    key(KEYS.c, ["command"]);
    await s.until("terminal.session", () => pasteboardText() === "COPYME",
      `Command+C did not copy the selection (the pasteboard holds ${JSON.stringify(pasteboardText())})`, { surface });
    assert.equal((await s.get("terminal.session", surface)).error, undefined);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real wheel scrolls the scrollback and a key returns to the newest output`, { timeout: 90000 }, async (t) => {
    const { s, surface, session, origin } = await prepare(t, app, "WHEELSTART");
    await s.run("terminal.input", { bytes: "i=0; while [ $i -lt 60 ]; do printf 'ROW%02d\\n' $i; i=$((i+1)); done\r" }, surface);
    const filled = await readScreenUntil(s, surface, (lines) => lines.some((line) => line === "ROW59"), "the rows did not render");
    const top = filled.find((line) => line.trim());
    const point = cellPoint(origin, session, 3, 3);
    post([{ type: "move", x: point.x, y: point.y }, { type: "wheel", x: point.x, y: point.y, lines: 5 }]);
    // 앱의 이벤트 모니터가 줄 단위 휠을 뷰 단위로 바꾸므로 움직인 줄 수는 보고만 한다.
    const scrolled = await s.until("terminal.session", (value) => value.scrollback?.offset > 0,
      "a real wheel did not move the viewport toward older output", { surface });
    t.diagnostic(`${app.name}: a five-line wheel moved the viewport ${scrolled.scrollback.offset} of ${scrolled.scrollback.history} lines`);
    const lines = await readScreenUntil(s, surface, (screen) => !screen.includes("ROW59"), "the viewport still shows the newest row");
    assert.notEqual(lines.find((line) => line.trim()), top, "the top row did not change");
    // 입력은 가장 새 출력으로 되돌린다. 포커스를 준 뒤 입력기와 무관한 Escape 키를 보낸다.
    click(point.x, point.y);
    await s.until("host.window", (window) => window.responder?.surface === surface, "the terminal did not take native focus");
    key(KEYS.escape);
    await s.until("terminal.session", (value) => value.scrollback?.offset === 0,
      "a key did not return the viewport to the newest output", { surface });
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real wheel on the alternate screen scrolls the program instead of the scrollback`, { timeout: 90000 }, async (t) => {
    const { s, surface, session, origin } = await prepare(t, app, "LESSSTART");
    s.cleanup(() => s.run("terminal.input", { bytes: "q" }, surface));
    await s.run("terminal.input", { bytes: "i=0; while [ $i -lt 200 ]; do printf 'ITEM%03d\\n' $i; i=$((i+1)); done | less\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines[0] === "ITEM000", "less did not show the first item");
    const point = cellPoint(origin, session, 3, 3);
    // 새 출력 쪽으로 굴리면 less 가 아래로 스크롤한다.
    post([{ type: "move", x: point.x, y: point.y }, { type: "wheel", x: point.x, y: point.y, lines: -3 }]);
    const lines = await readScreenUntil(s, surface, (screen) => screen[0] !== "ITEM000" && /^ITEM\d{3}$/.test(screen[0]),
      "a wheel on the alternate screen did not scroll less");
    t.diagnostic(`${app.name}: less shows ${lines[0]} at the top after the wheel`);
    assert.equal((await s.get("terminal.session", surface)).scrollback.offset, 0, "the wheel moved the scrollback viewport");
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real drag that leaves the view selects to the nearest cell`, { timeout: 90000 }, async (t) => {
    const { s, surface, session, origin, row } = await prepare(t, app, "LEFTEDGE");
    writePasteboard([{ "public.utf8-plain-text": Buffer.from("BEFORE").toString("base64") }]);
    const before = (await s.get("terminal.session", surface)).selectionReleases;
    // 줄의 처음을 선택하려는 끌기는 포인터가 뷰의 왼쪽 밖으로 나가기 쉽다.
    const start = cellPoint(origin, session, 5, row);
    dragPath(start, { x: origin.x - 20, y: start.y });
    await s.until("terminal.session", (value) => value.selectionReleases === before + 1,
      "the sidecar did not answer the release of a drag that left the view", { surface });
    await s.until("terminal.session", () => pasteboardText() === "LEFTED",
      `the drag did not select to the first cell (the pasteboard holds ${JSON.stringify(pasteboardText())})`, { surface });
    assert.equal((await s.get("terminal.session", surface)).error, undefined);
  });
}

// 화면에 선택으로 그려진 글자. 사이드카가 그린 화면의 반전 칸을 읽는다.
async function selectedCharacters(s, surface, row) {
  await s.run("terminal.screen.read", {}, surface);
  const lines = await s.get("terminal.screen", surface);
  return lines[row].filter((cell) => cell.inverse).map((cell) => cell.ch ?? " ").join("").trimEnd();
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real drag, Command+C, and Command+V paste exactly the characters shown as selected`, { timeout: 180000 }, async (t) => {
    const line = "0123456789ABCDEFGHIJ";
    const { s, surface, session, origin, row } = await prepare(t, app, line);
    const view = await s.rect("terminal.view", undefined, surface);
    const cases = [
      ["forward", cellPoint(origin, session, 2, row), cellPoint(origin, session, 8, row)],
      ["backward", cellPoint(origin, session, 12, row), cellPoint(origin, session, 4, row)],
      ["past the left edge", cellPoint(origin, session, 6, row), { x: origin.x - 20, y: cellPoint(origin, session, 0, row).y }],
      ["past the right edge", cellPoint(origin, session, 15, row), { x: origin.x + view.width + 20, y: cellPoint(origin, session, 0, row).y }],
    ];
    for (const [name, from, to] of cases) {
      const before = (await s.get("terminal.session", surface)).selectionReleases;
      dragPath(from, to);
      await s.until("terminal.session", (value) => value.selectionReleases === before + 1,
        `the sidecar did not answer the ${name} drag`, { surface });
      await s.until("host.window", (window) => window.responder?.surface === surface, "the terminal did not take native focus");
      const shown = await selectedCharacters(s, surface, row);
      assert.ok(shown.length > 0, `the ${name} drag showed no selected characters`);
      key(KEYS.c, ["command"]);
      key(KEYS.v, ["command"]);
      const pasted = await readScreenUntil(s, surface, (lines) => lines.some((text) => text.startsWith("sh-3.2$ ") && text.length > 8),
        `the ${name} selection was not pasted`);
      const typed = pasted.find((text) => text.startsWith("sh-3.2$ ") && text.length > 8).slice(8);
      t.diagnostic(`${app.name} ${name}: shown ${JSON.stringify(shown)} pasted ${JSON.stringify(typed)}`);
      assert.equal(typed, shown, `the ${name} drag pasted other characters than it showed as selected`);
      // 붙여넣은 입력 줄을 지운다(Control+U).
      key(32, ["control"]);
      await readScreenUntil(s, surface, (lines) => !lines.some((text) => text.startsWith("sh-3.2$ ") && text.length > 8),
        "the pasted input was not cleared");
    }
  });
}

// 화면 좌표 한 점의 표시된 픽셀.
async function screenPixel(s, point) {
  await s.request("diagnostics.capture.start", {});
  const displayed = await s.presented();
  const { frames: directory } = await s.request("diagnostics.capture.stop", { after: displayed.displayed });
  try {
    const files = frames(directory);
    assert.ok(files.length > 0, "the capture produced no frames");
    const frame = readFrame(files.at(-1));
    const { frame: window } = await s.get("host.window");
    return pixel(frame, Math.round((point.x - window.x) * frame.scale), Math.round((point.y - window.y) * frame.scale));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a terminal with history shows a scrollbar whose thumb moves the viewport when dragged`, { timeout: 120000 }, async (t) => {
    const { s, surface, session, origin } = await prepare(t, app, "BARSTART");
    await s.run("terminal.input", { bytes: "i=0; while [ $i -lt 80 ]; do printf 'ROW%02d\\n' $i; i=$((i+1)); done\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line === "ROW79"), "the rows did not render");
    const newest = await s.until("terminal.session", (value) => value.scrollback?.history > 0 && value.scrollback.offset === 0,
      "the output did not exceed the screen", { surface });

    // 기록이 있으면 스크롤하기 전에도 스크롤바가 보이고 손잡이는 트랙 맨 아래에 있다.
    const track = await s.rect("terminal.scrollbar", undefined, surface);
    const bottomThumb = await s.rect("terminal.scrollbar.thumb", undefined, surface);
    assert.ok(track.width > 0 && bottomThumb.height >= 16, `the scrollbar is not shown with history: ${JSON.stringify({ track, bottomThumb })}`);
    assert.ok(Math.abs(bottomThumb.y + bottomThumb.height - (track.y + track.height)) <= 1,
      `the thumb is not at the bottom at the newest output: ${JSON.stringify({ track, bottomThumb })}`);

    // 손잡이를 맨 위로 끌면 가장 오래된 기록이 보인다.
    const trackTop = (await screenCenter(s, track)).y - track.height / 2;
    const start = await screenCenter(s, bottomThumb);
    dragPath(start, { x: start.x, y: trackTop - 30 });
    const top = await s.until("terminal.session", (value) => value.scrollback.offset === value.scrollback.history,
      "dragging the thumb to the top did not show the oldest history", { surface });
    t.diagnostic(`${app.name}: history ${newest.scrollback.history}, top offset ${top.scrollback.offset}`);
    const topThumb = await screenCenter(s, await s.rect("terminal.scrollbar.thumb", undefined, surface));
    const withThumb = await screenPixel(s, topThumb);

    // 맨 아래로 끌면 가장 새 출력으로 돌아온다. 위쪽 자리의 픽셀은 손잡이가 떠난 뒤 달라야 한다.
    dragPath(topThumb, { x: topThumb.x, y: trackTop + track.height + 30 });
    await s.until("terminal.session", (value) => value.scrollback.offset === 0,
      "dragging the thumb to the bottom did not return to the newest output", { surface });
    const withoutThumb = await screenPixel(s, topThumb);
    assert.ok(!same(withThumb, withoutThumb),
      `the thumb was not drawn: the same point shows ${withThumb} with the thumb and ${withoutThumb} without it`);
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: text stays drawn in every frame while a real wheel scrolls`, { timeout: 120000 }, async (t) => {
    const { s, surface, session, origin } = await prepare(t, app, "FLICKER");
    await s.run("terminal.input", { bytes: "i=0; while [ $i -lt 200 ]; do printf 'LINE%03d text text text text\\n' $i; i=$((i+1)); done\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line.startsWith("LINE199")), "the lines did not render");
    const region = (await s.get("host.window")).regions.find((item) => item.surface === surface && item.name === "view");
    const point = cellPoint(origin, session, 3, 3);
    await s.request("diagnostics.capture.start", {});
    const steps = [{ type: "move", x: point.x, y: point.y }];
    for (let i = 0; i < 8; i++) steps.push({ type: "wheel", x: point.x, y: point.y, lines: 2, wait: 40 });
    for (let i = 0; i < 8; i++) steps.push({ type: "wheel", x: point.x, y: point.y, lines: -2, wait: 40 });
    // 트랙패드처럼 작은 픽셀 이동을 짧은 간격으로 많이 보낸다.
    for (let i = 0; i < 60; i++) steps.push({ type: "wheel", unit: "pixel", x: point.x, y: point.y, lines: i < 30 ? 5 : -5, wait: 8 });
    post(steps);
    const displayed = await s.presented();
    const { frames: directory } = await s.request("diagnostics.capture.stop", { after: displayed.displayed });
    try {
      const files = frames(directory);
      assert.ok(files.length > 10, `the recording has only ${files.length} frames`);
      // 글자 픽셀: 터미널 영역(스크롤바 열 제외) 안의 밝은 픽셀 수를 줄 간격마다 센다.
      // 글자가 사라진 프레임을 해석하도록 영역 중앙과 영역 위 카드 머리의 색을 함께 적는다.
      const samples = [];
      const counts = files.map((file) => {
        const frame = readFrame(file);
        samples.push({
          center: pixel(frame, Math.round((region.frame.x + region.frame.width / 2) * frame.scale), Math.round((region.frame.y + region.frame.height / 2) * frame.scale)).join(","),
          above: pixel(frame, Math.round((region.frame.x + 20) * frame.scale), Math.round((region.frame.y - 12) * frame.scale)).join(","),
        });
        let count = 0;
        const left = Math.round(region.frame.x * frame.scale), top = Math.round(region.frame.y * frame.scale);
        const right = Math.round((region.frame.x + region.frame.width - 12) * frame.scale);
        const bottom = Math.round((region.frame.y + region.frame.height) * frame.scale);
        for (let y = top; y < bottom; y += 2) for (let x = left; x < right; x += 2) {
          if (pixel(frame, x, y).every((value) => value > 150)) count++;
        }
        return count;
      });
      t.diagnostic(`${app.name}: text pixels per frame min ${Math.min(...counts)} max ${Math.max(...counts)} over ${counts.length} frames`);
      const first = counts[0];
      const dropped = counts.map((count, index) => [index, count, samples[index], samples[index - 1] ?? null])
        .filter(([, count]) => count < first / 2);
      assert.deepEqual(dropped, [], `frames lost most of their text while scrolling (first frame ${first} text pixels): ${JSON.stringify(dropped)}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: scrollbar settings change the drawn track width, thumb color, and shape`, { timeout: 120000 }, async (t) => {
    const { s, surface } = await prepare(t, app, "BARSETTINGS");
    await s.run("terminal.input", { bytes: "i=0; while [ $i -lt 60 ]; do printf 'ROW%02d\\n' $i; i=$((i+1)); done\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line === "ROW59"), "the rows did not render");
    await s.until("terminal.session", (value) => value.scrollback?.history > 0, "the output did not exceed the screen", { surface });
    const set = (key, value) => s.run("core.settings.change", { key: `terminal.scrollbar.${key}`, value, scope: "common" });
    await set("width", 20);
    await set("thumb", "#ff0000");
    await set("track", "#0000ff");
    await set("shape", "square");
    const track = await s.rect("terminal.scrollbar", undefined, surface);
    assert.equal(track.width, 20, `the track width setting was not applied: ${JSON.stringify(track)}`);
    const thumbRect = await s.rect("terminal.scrollbar.thumb", undefined, surface);
    const center = await screenCenter(s, thumbRect);
    const corner = { x: center.x - thumbRect.width / 2 + 1, y: center.y - thumbRect.height / 2 + 1 };
    const near = (actual, expected) => actual.every((value, index) => Math.abs(value - expected[index]) <= 24);
    const drawn = await screenPixel(s, center);
    assert.ok(near(drawn, [255, 0, 0]), `the thumb color setting was not drawn: ${drawn}`);
    const squareCorner = await screenPixel(s, corner);
    assert.ok(near(squareCorner, [255, 0, 0]), `a square thumb does not fill its corner: ${squareCorner}`);
    await set("shape", "rounded");
    const roundCorner = await screenPixel(s, corner);
    assert.ok(near(roundCorner, [0, 0, 255]), `a rounded thumb corner does not show the track color: ${roundCorner}`);
    const trackPixel = await screenPixel(s, { x: center.x, y: center.y - thumbRect.height / 2 - 4 });
    t.diagnostic(`${app.name}: thumb ${drawn}, square corner ${squareCorner}, rounded corner ${roundCorner}, track ${trackPixel}`);
  });
}

// 링크를 여는 검사는 사용자의 기본 브라우저에 example.com 탭을 연다. 사용자가 승인한 실행에서만 돈다.
const LINK = "https://example.com/soksak-link-check";

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real Command-click on an OSC 8 link opens it through the host and a plain click does not`, { timeout: 90000 }, async (t) => {
    const { s, surface, session, origin, row } = await prepare(t, app, "LINKROW");
    await s.run("terminal.input", { bytes: `clear; printf '\\033]8;;${LINK}\\007LINKTEXT\\033]8;;\\007\\n'\r` }, surface);
    const lines = await readScreenUntil(s, surface, (screen) => screen.includes("LINKTEXT"), "the link did not render");
    const linkRow = lines.indexOf("LINKTEXT");
    const point = cellPoint(origin, session, 3, linkRow);
    const log = await s.transcript();
    s.cleanup(() => log.stop());
    // 누름 없는 이동은 손 모양 포인터와 포인터 아래 링크를 알린다.
    const cells = (await s.get("terminal.screen", surface))[linkRow].slice(0, 8).map((cell) => cell.link ?? null);
    assert.deepEqual(cells, Array(8).fill(LINK), "the screen does not carry the link on its cells");
    // 포인터는 링크 밖의 칸에서 링크 칸으로 들어온다. 같은 점으로의 이동은 페이지에 이동을 알리지 않는다.
    const outside = cellPoint(origin, session, 20, linkRow);
    post([{ type: "move", x: outside.x, y: outside.y }, { type: "move", x: point.x, y: point.y }]);
    await s.until("terminal.session", (value) => value.link === LINK,
      `the hovered link was not reported at ${JSON.stringify(point)} (view origin ${JSON.stringify(origin)})`, { surface });
    click(point.x, point.y);
    await s.until("terminal.session", (value) => value.selectionReleases > session.selectionReleases,
      "the plain click did not end as a selection click", { surface });
    assert.equal(log.lines.some((line) => line.startsWith("host linkOpen")), false, "a plain click opened the link");
    click(point.x, point.y, ["command"]);
    const opened = await log.until((all) => all.some((line) => line.startsWith("host linkOpen") && line.includes(LINK) && / -> /.test(line)),
      "the host did not answer a linkOpen request", 10000);
    const answer = opened.find((line) => line.startsWith("host linkOpen"));
    assert.doesNotMatch(answer, /error|reject/i, `the host rejected the link: ${answer}`);
    assert.equal((await s.get("terminal.session", surface)).error ?? null, null, "the link open left a session error");
  });
}

// 휠 스크롤 측정. 줄 i 는 i % 97 번째 열에 '#' 하나를 가진다. 각 녹화 프레임의 맨 위 행에서 '#' 의 열을 읽으면
// 그 프레임이 보인 줄을 97 을 법으로 알 수 있고, 이웃 프레임의 차이로 이동한 줄 수를 얻는다.
const MARKS = 97;

function topMark(frame, region, session) {
  const top = Math.round(region.frame.y * frame.scale);
  const bottom = Math.round((region.frame.y + session.cellHeight) * frame.scale);
  let best = null;
  let bestCount = 0;
  for (let column = 0; column < MARKS; column++) {
    const left = Math.round((region.frame.x + column * session.cellWidth) * frame.scale);
    const right = Math.round((region.frame.x + (column + 1) * session.cellWidth) * frame.scale);
    let count = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      if (pixel(frame, x, y).every((value) => value > 150)) count++;
    }
    if (count > bestCount) { best = column; bestCount = count; }
  }
  return bestCount >= 4 ? best : null;
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: a real wheel over a long history is shown without lag, stalls, or reversal`, { timeout: 240000 }, async (t) => {
    const { s, surface, session, origin } = await prepare(t, app, "WHEELSTART");
    assert.ok(session.cols > MARKS, `the terminal has ${session.cols} columns; the check needs more than ${MARKS}`);
    await s.run("terminal.input", {
      bytes: "clear; awk 'BEGIN{for(i=0;i<100000;i++) printf \"%\" (i%97+1) \"s\\n\", \"#\"}'; printf 'WHEELREADY\\n'\r",
    }, surface);
    const writeStart = performance.now();
    await s.run("terminal.screen.read", {}, surface);
    await s.until("terminal.screen", (rows) => rows.some((row) => row.map((cell) => cell.ch ?? " ").join("").trim() === "WHEELREADY"),
      "100,000 lines were not written", { surface, timeout: 180000 });
    const writeMs = Math.round(performance.now() - writeStart);
    t.diagnostic(`${app.name}: 100,000 lines were written and shown in ${writeMs} ms`);
    const history = (await s.get("terminal.session", surface)).scrollback.history;
    const region = (await s.get("host.window")).regions.find((item) => item.surface === surface && item.name === "view");
    const point = cellPoint(origin, session, 50, 5);
    post([{ type: "move", x: point.x, y: point.y }]);
    await s.request("diagnostics.capture.start", {});
    // 사람이 휠을 계속 굴리듯 16 ms 마다 3줄씩 120번 보낸다.
    const steps = [];
    for (let i = 0; i < 120; i++) steps.push({ type: "wheel", x: point.x, y: point.y, lines: 3 });
    const sent = post(steps);
    const displayed = await s.presented();
    const { frames: directory } = await s.request("diagnostics.capture.stop", { after: displayed.displayed });
    try {
      const final = (await s.get("terminal.session", surface)).scrollback.offset;
      const files = frames(directory);
      assert.ok(files.length > 30, `the recording has only ${files.length} frames`);
      const shown = [];
      let previous = null;
      let moved = 0;
      let backward = 0;
      let largest = 0;
      for (const file of files) {
        const frame = readFrame(file);
        const mark = topMark(frame, region, session);
        assert.notEqual(mark, null, `frame at ${frame.time} ms shows no line mark in the top row`);
        if (previous !== null) {
          // 위로 스크롤하면 맨 위 줄 번호가 줄어든다. 차이를 (-48, 48] 로 옮겨 이동한 줄 수를 얻는다.
          let delta = ((previous - mark) % MARKS + MARKS) % MARKS;
          if (delta > MARKS / 2) delta -= MARKS;
          if (delta < 0) backward++;
          largest = Math.max(largest, Math.abs(delta));
          moved += delta;
        }
        previous = mark;
        shown.push({ time: frame.time, moved });
      }
      const inputStart = sent[0];
      const inputEnd = sent.at(-1);
      const firstMove = shown.find((item) => item.moved > 0);
      const settled = shown.find((item) => item.moved === moved);
      // 입력이 이어지는 동안 화면이 바뀌지 않은 가장 긴 시간.
      let stall = 0;
      let changedAt = firstMove?.time ?? inputStart;
      for (let index = 1; index < shown.length; index++) {
        if (shown[index].time > inputEnd) break;
        if (shown[index].moved !== shown[index - 1].moved) changedAt = shown[index].time;
        else stall = Math.max(stall, shown[index].time - changedAt);
      }
      const intervals = shown.slice(1).map((item, index) => item.time - shown[index].time);
      const report = {
        writeMs, history, final, displayedLines: moved, frames: shown.length,
        inputMs: Math.round(inputEnd - inputStart),
        startLagMs: firstMove ? Math.round(firstMove.time - inputStart) : null,
        endLagMs: Math.round(settled.time - inputEnd),
        longestStallMs: Math.round(stall),
        largestStepLines: largest, backwardFrames: backward,
        medianFrameMs: intervals.sort((a, b) => a - b)[Math.floor(intervals.length / 2)],
      };
      t.diagnostic(`${app.name}: ${JSON.stringify(report)}`);
      assert.equal(moved, final, `the display moved ${moved} lines but the viewport is at ${final}: ${JSON.stringify(report)}`);
      assert.equal(backward, 0, `the display moved backward: ${JSON.stringify(report)}`);
      assert.ok(report.startLagMs !== null && report.startLagMs <= 50, `the first wheel event was shown late: ${JSON.stringify(report)}`);
      assert.ok(report.endLagMs <= 50, `the last wheel event was shown late: ${JSON.stringify(report)}`);
      assert.ok(report.longestStallMs <= 50, `the display stalled while the wheel turned: ${JSON.stringify(report)}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const app of Object.values(APPS)) {
  test(`${app.name}: the scrollbar thumb shows an open hand and a closed hand while it is dragged`, { timeout: 120000 }, async (t) => {
    const { s, surface, origin, session } = await prepare(t, app, "CURSORSTART");
    await s.run("terminal.input", { bytes: "i=0; while [ $i -lt 80 ]; do printf 'ROW%02d\\n' $i; i=$((i+1)); done\r" }, surface);
    await readScreenUntil(s, surface, (lines) => lines.some((line) => line === "ROW79"), "the rows did not render");
    await s.until("terminal.session", (value) => value.scrollback?.history > 0, "the output did not exceed the screen", { surface });
    const thumb = await screenCenter(s, await s.rect("terminal.scrollbar.thumb", undefined, surface));
    const text = cellPoint(origin, session, 3, 2);
    // 포인터가 글자 위에서 손잡이로 들어온다. 표시된 뒤의 시스템 커서를 읽는다.
    post([{ type: "move", x: text.x, y: text.y }, { type: "move", x: thumb.x, y: thumb.y }]);
    await s.presented();
    assert.equal(systemCursor(), "openHand", "the pointer over the scrollbar thumb is not an open hand");
    // 창이 다시 키 창이 되면 AppKit 이 커서 영역을 다시 만든다. 포인터가 손잡이 위에 있는 채로 다시 활성화한다.
    activateFinder();
    await s.until("host.window", (window) => window.active === false, "the application stayed active");
    await bringFront(s, app, await s.rect("terminal.scrollbar.thumb", undefined, surface));
    await s.presented();
    assert.equal(systemCursor(), "openHand", "the pointer over the scrollbar thumb is not an open hand after the window became key");
    post([{ type: "down", x: thumb.x, y: thumb.y }, { type: "drag", x: thumb.x, y: thumb.y - 10 }, { type: "drag", x: thumb.x, y: thumb.y - 20 }]);
    await s.presented();
    const dragging = systemCursor();
    post([{ type: "up", x: thumb.x, y: thumb.y - 20 }]);
    assert.equal(dragging, "closedHand", "the pointer while the thumb is dragged is not a closed hand");
  });
}
