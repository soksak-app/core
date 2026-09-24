// 실제 입력 등급 터미널 검사: 사람의 마우스와 키보드가 지나는 경로(창 서버, 키 창, 메뉴 키 대응)로 터미널
// 선택, 복사, 붙여넣기, 휠을 검사한다. 사용자가 승인한 실행에서 pnpm -F @soksak/e2e verify:real 로만 실행한다.
import assert from "node:assert/strict";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { APPS, fresh, open } from "../app.mjs";
import { frames, pixel, readFrame } from "../frame.mjs";
import { ensureTerminals, readScreenUntil } from "../terminal-screen.mjs";
import { bringFront, click, dragPath, key, KEYS, keepPasteboard, pasteboardText, requireTrusted, screenCenter, writePasteboard } from "./hid.mjs";

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
