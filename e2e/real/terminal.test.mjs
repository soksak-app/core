// 실제 입력 등급 터미널 검사: 사람의 마우스와 키보드가 지나는 경로(창 서버, 키 창, 메뉴 키 대응)로 터미널
// 선택, 복사, 붙여넣기, 휠을 검사한다. 사용자가 승인한 실행에서 pnpm -F @soksak/e2e verify:real 로만 실행한다.
import assert from "node:assert/strict";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, fresh, open } from "../app.mjs";
import { frames, pixel, readFrame } from "../frame.mjs";
import { ensureTerminals, readScreenUntil } from "../terminal-screen.mjs";
import { bringFront, click, dragPath, key, KEYS, keepPasteboard, pasteboardText, post, requireTrusted, screenCenter, writePasteboard } from "./hid.mjs";

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
