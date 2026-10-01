// 창 검사가 터미널 표면을 준비하고 화면 글자를 읽는 도우미.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { frames, pixel, readFrame } from "./frame.mjs";

export function textLines(screen) {
  assert.ok(screen && Array.isArray(screen.lines), `invalid terminal screen: ${JSON.stringify(screen)}`);
  return screen.lines.map((row) => row.map((cell) => {
    assert.ok(Number.isInteger(cell.width) && cell.width >= 0, "cell width is required");
    return cell.ch === undefined ? " ".repeat(cell.width) : cell.ch;
  }).join("").trimEnd());
}

export async function readScreenUntil(session, surface, predicate, message) {
  // 현재 화면을 한 번 읽고 이후 출력은 알림으로 기다린다. 리사이즈도 이 읽기에 반영된다.
  await session.run("terminal.screen.read", {}, surface);
  const screen = await session.until("terminal.screen",
    (lines) => predicate(textLines({ lines })), message, { surface });
  return textLines({ lines: screen });
}

export async function ensureTerminals(session, count) {
  // fixture는 shell 탭이 활성인 상태로 시작한다. 보이는 native terminal surface를 측정하기
  // 전에 선언된 terminal을 선택한다. 비활성 탭을 기다리면 테스트 준비 실수가
  // 거짓 런타임 실패로 바뀐다.
  const initialGrid = await session.get("core.grid");
  const terminalTab = initialGrid.cards.flatMap((card) => card.tabs)
    .find((tab) => tab.plugin === "terminal");
  assert.ok(terminalTab, "the fixture has no terminal tab");
  const owner = initialGrid.cards.find((card) => card.tabs.some((tab) => tab.id === terminalTab.id));
  if (owner?.active !== terminalTab.id) await session.run("core.tab.select", { tab: terminalTab.id });
  await session.until(
    "core.surfaces",
    (surfaces) => surfaces.some((item) => item.visible && item.plugin === "terminal"),
    "the fixture terminal did not register before splitting",
  );
  let terminals = (await session.surfaces("terminal")).length;
  while (terminals < count) {
    // 가장 큰 터미널 카드를 긴 쪽으로 나눈다. 고정 사이드바와 카드 사이드바가 공간을 차지하므로 한 방향으로만 나누면
    // 최소 크기 규칙에 걸린다.
    const grid = await session.get("core.grid");
    const [card] = grid.cards.filter((item) => item.active && item.tabs.some((tab) => tab.plugin === "terminal"))
      .sort((a, b) => b.w * b.h - a.w * a.h);
    assert.ok(card, "a visible terminal card was not found for splitting");
    await session.run("core.card.split", { card: card.id, axis: card.w >= card.h ? "x" : "y", plugin: "terminal" });
    await session.until(
      "core.surfaces",
      (surfaces) => surfaces.filter((item) => item.visible && item.plugin === "terminal").length >= terminals + 1,
      `terminal count did not reach ${terminals + 1}`
    );
    terminals = (await session.get("core.surfaces"))
      .filter((item) => item.visible && item.plugin === "terminal").length;
  }
  await session.until(
    "core.surfaces",
    (surfaces) => {
      const visible = surfaces.filter((item) => item.visible && item.plugin === "terminal");
      return visible.length >= count && visible.every((item) =>
        item.exposes.includes("status terminal.session"));
    },
    `terminal native surfaces did not reach ${count} with terminal.session registered`
  );
  return session.surfaces("terminal");
}

/**
 * 픽셀 측정용 터미널 배경. 터미널은 카드 색(--card)으로 그리므로 배경만으로는 카드와 구별되지 않는다.
 * 검사는 프로그램이 쓰는 OSC 11 로 기본 배경을 이 색으로 바꾸어 네이티브 래스터가 칠한 자리만 이 색이 되게 한다.
 */
export const MEASURED_BACKGROUND = [30, 30, 30];

/** OSC 11 로 터미널의 기본 배경을 MEASURED_BACKGROUND 로 바꾸고 그 뒤의 출력이 화면에 나올 때까지 기다린다. */
export async function setMeasuredBackground(session, surface) {
  const hex = MEASURED_BACKGROUND.map((value) => value.toString(16).padStart(2, "0")).join("/");
  const marker = `BACKGROUND-${surface}`;
  await session.run("terminal.input", { bytes: `printf '\\033]11;rgb:${hex}\\007${marker}\\n'\r` }, surface);
  await readScreenUntil(session, surface, (lines) => lines.some((line) => line.startsWith(marker)),
    `${surface} did not finish the OSC 11 background change`);
}

/**
 * 표시된 창 프레임에서 칸마다 배경 픽셀을 읽는다. 페이지의 화면 셀은 색을 싣지 않으므로 선택처럼 색으로만
 * 보이는 상태는 픽셀로 잰다. 칸의 왼쪽 위 모서리 가까이를 읽어 글자 획을 피한다. cells 는 {col, row} 목록이다.
 */
export async function cellBackgrounds(session, surface, cells) {
  await session.request("diagnostics.capture.start", {});
  const { displayed } = await session.presented();
  const { frames: dir } = await session.request("diagnostics.capture.stop", { after: displayed });
  try {
    const files = frames(dir);
    assert.ok(files.length > 0, "the cell capture produced no frames");
    const frame = readFrame(files.at(-1));
    const view = await session.rect("terminal.view", undefined, surface);
    const { cellWidth, cellHeight } = await session.get("terminal.session", surface);
    return cells.map(({ col, row }) => pixel(frame,
      Math.round((view.document.x + view.x + (col + 0.1) * cellWidth) * frame.scale),
      Math.round((view.document.y + view.y + (row + 0.08) * cellHeight) * frame.scale)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 강조 색이 없을 때 선택한 칸의 배경. 현재 테마의 --rail 다(docs/spec/terminal-runtime.md). */
export async function selectionBackground(session) {
  const { values } = await session.get("core.settings");
  const THEMES = await session.get("core.themes");
  return THEMES.find((item) => item.name === values.theme)[values.mode].rail;
}

/** 픽셀이 #rrggbb 색과 채널마다 2 이내인지. */
export function isColor(sample, hex) {
  return sample.every((value, index) => Math.abs(value - parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16)) <= 2);
}
