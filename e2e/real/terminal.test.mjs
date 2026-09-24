// 실제 입력 등급 터미널 검사: 사람의 마우스와 키보드가 지나는 경로(창 서버, 키 창, 메뉴 키 대응)로 터미널
// 선택, 복사, 붙여넣기, 휠을 검사한다. 사용자가 승인한 실행에서 pnpm -F @soksak/e2e verify:real 로만 실행한다.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { APPS, fresh, open } from "../app.mjs";
import { frames, pixel, readFrame } from "../frame.mjs";
import { ensureTerminals, readScreenUntil } from "../terminal-screen.mjs";
import { bringFront, click, dragPath, keepPasteboard, pasteboardText, requireTrusted } from "./hid.mjs";

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
