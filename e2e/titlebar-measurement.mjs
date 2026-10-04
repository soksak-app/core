// 녹화 프레임 하나에서 창 단추의 가운데와 첫 행의 가운데를 픽셀로 잰다(docs/spec/native-surfaces.md#title-bar-height).
// 판정이 어긋난 프레임과 잴 수 없는 프레임을 거부하는지 test/titlebar-measurement.test.mjs 가 검사한다.
import { pixel } from "./frame.mjs";

/** 단추 가운데와 첫 행 가운데가 다를 수 있는 가장 큰 거리(px). */
export const TOLERANCE = 0.5;

/** 프레임 배율 factor 에서 첫 행의 높이(px). 페이지의 --chrome-row 와 같은 식이다. */
export const rowHeight = (factor) => Math.round(Math.max(40, 36 * factor));

// 단추를 찾기 시작하는 행(창 위 기준 pt). 창의 둥근 모서리는 이 행 위에 있다. 제목줄은 32pt 보다 낮지 않으므로
// 14pt 단추의 위는 9pt 보다 위에 있지 않다.
const START = 8;
// 제목줄은 200pt 보다 높지 않다. 첫 행의 아래 테두리는 이 행 안에 있다.
const LIMIT = 202;
// 첫 행 바탕과 아래 테두리(--card 와 --edge)는 채널마다 18 이상 다르다.
const EDGE = 6;
// 창 단추(비활성 창의 회색 단추도)는 첫 행 바탕과 이보다 크게 다르다.
const INK = 16;
// 단추 영역 오른쪽 끝에서 바탕 색과 아래 테두리를 재는 열까지의 거리(pt). 첫 행은 단추 영역 오른쪽에 12px 여백을 둔다.
const GAP = 6;

const differs = (a, b, tolerance) => a.some((value, index) => Math.abs(value - b[index]) > tolerance);

/**
 * 프레임 frame(readFrame 의 결과)에서 첫 행의 아래 끝 row 와 창 단추의 세로 가운데 buttons 를 창 위 기준 pt 로 잰다.
 * buttons 는 host.window 의 controls(창 좌표 pt)이며 가로 위치만 쓴다.
 *
 * 첫 행: 단추 영역 오른쪽의 빈 열을 START 부터 아래로 읽어, 첫 행 바탕과 다른 첫 줄(아래 테두리)이 끝나는 곳이 행의
 * 아래 끝이다. 행의 위는 창의 위이므로 행의 가운데는 row / 2 다.
 * 단추: 각 단추의 가운데 절반 열에서 START 부터 테두리 위까지 바탕과 INK 넘게 다른 첫 행과 마지막 행의 가운데다.
 * 원을 지나는 세로 열은 원의 가운데에 대해 대칭이므로 단추가 옆으로 옮겨져도 가운데는 같다.
 *
 * 잴 수 없으면 그 까닭과 자리를 missing 으로 반환한다. 잴 수 없는 프레임은 통과가 아니다.
 */
export function measureTitlebar(frame, buttons) {
  if (!Array.isArray(buttons) || buttons.length === 0) throw new Error("the window reports no button frames");
  const scale = frame.scale * frame.contentScale;
  const left = frame.content.x * frame.scale;
  const top = frame.content.y * frame.scale;
  const px = (x) => Math.floor(left + x * scale);
  const py = (y) => Math.floor(top + y * scale);
  const right = Math.max(...buttons.map((button) => button.x + button.width));
  const column = px(right + GAP);
  const start = py(START);
  const limit = Math.min(frame.height, py(LIMIT));
  if (column >= frame.width || start >= limit) {
    return { time: frame.time, missing: `the frame ${frame.width}x${frame.height} has no column ${right + GAP}pt below ${START}pt` };
  }
  const background = pixel(frame, column, start);
  let y = start;
  while (y < limit && !differs(pixel(frame, column, y), background, EDGE)) y++;
  if (y >= limit) {
    return { time: frame.time, missing: `no first-row edge below ${START}pt in column ${right + GAP}pt (background ${background})` };
  }
  const edge = y;
  const line = pixel(frame, column, edge);
  while (y < limit && !differs(pixel(frame, column, y), line, EDGE)) y++;
  const row = (y - top) / scale;
  const columns = buttons.flatMap((button) => {
    const from = px(button.x + button.width / 4);
    const to = px(button.x + button.width * 3 / 4);
    return Array.from({ length: Math.max(0, to - from) }, (_, index) => from + index);
  });
  let first = -1;
  let last = -1;
  for (let at = start; at < edge; at++) {
    if (columns.some((x) => differs(pixel(frame, x, at), background, INK))) {
      if (first < 0) first = at;
      last = at;
    }
  }
  if (first < 0) return { time: frame.time, row, missing: `no window button above the first-row edge at ${(edge - top) / scale}pt` };
  if (first === start) return { time: frame.time, row, missing: `window button ink reaches the scan start ${START}pt` };
  const centre = ((first - top) + (last - top) + 1) / 2 / scale;
  return { time: frame.time, row, buttons: centre, difference: centre - row / 2 };
}

/** 단추 가운데가 첫 행 가운데와 tolerance 넘게 다르거나 잴 수 없는 프레임. */
export function misaligned(measured, tolerance = TOLERANCE) {
  return measured.filter((frame) => frame.missing !== undefined || Math.abs(frame.difference) > tolerance);
}
