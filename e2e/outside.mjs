// 표면이 자기 카드 밖에 그려졌는지 한 프레임 안에서 잰다.
//
// 규칙은 하나다 — 네이티브 표면은 자기 카드가 그려진 자리에만 그려진다. 판은 표면의
// 자리를 그리기 전에 호스트에 알리고, 호스트는 그 자리에 뷰를 옮기며, 페이지의
// 그리기와 뷰의 이동은 서로 다른 합성 층에서 각자의 프레임에 실린다. 두 층이 한
// 프레임 어긋나면 표면은 카드가 아직 가지 않은 자리에 그려지고, 어긋남의 크기는
// 경계가 한 걸음에 움직인 거리다.
//
// 커밋 안의 숫자로는 보이지 않는다. 페이지가 선언한 자리와 호스트가 앉힌 자리는
// 정확히 같고, 그려진 요소와 선언한 자리도 정확히 같다. 어긋나는 것은 그 둘이 화면에
// 실리는 시각이므로 합성된 픽셀로만 잰다.
//
// 카드는 표면이 닿지 않는 머리 행에서 읽는다. 머리는 문서가 그리는 행이므로 그
// 행의 카드는 페이지가 지금 그린 자리에 있다. 표면은 자기 배경색이 차지한 가로
// 구간으로 읽는다. 둘이 한 프레임에서 나오므로 시계가 끼어들지 않는다.
import { pixel } from "./frame.mjs";

/**
 * 셸 표면의 배경. 기본 테마 midnight 의 --surface(#0d1a14)다. 캡처는 sRGB 로 기록하므로
 * 테마 값을 그대로 쓴다(packages/workbench/settings.js).
 */
const TERM = [13, 26, 20];
/** 카드의 배경. 머리와 발이 이 색이다. midnight 테마의 --card(#191b24). */
const CARD = [25, 27, 36];
/** 판의 배경. 카드 사이의 통로가 이 색이다. midnight 테마의 --bg(#101117). */
const PLANE = [16, 17, 23];
/** 카드의 테두리. 평소(--edge #2b2e3d)와 포커스를 받았을 때(--focus #ffb36b). */
const BORDERS = [[43, 46, 61], [255, 179, 107]];

/** 이만큼 벗어난 색은 그 색이 아니다. */
const NEAR = 5;

/** 표면이 그리는 글자가 만드는 틈. 이보다 짧은 틈은 같은 표면으로 잇는다. */
const GAP = 12;

const near = (p, q) => p.every((v, i) => Math.abs(v - q[i]) <= NEAR);
const any = (p, list) => list.some((q) => near(p, q));

/**
 * 표면이 가로로 차지한 구간.
 *
 * 가장 긴 연속 구간에서 시작해 글자가 만드는 틈을 건너뛰며 좌우로 넓힌다. 표면은
 * 사각형 하나이므로 한 행의 구간이 그 폭이다.
 */
function surfaceRun(f) {
  const px = (x, y) => pixel(f, x, y);
  let best = null;
  for (let y = 0; y < f.height; y += 2) {
    let x = 0;
    while (x < f.width) {
      if (!near(px(x, y), TERM)) { x++; continue; }
      const from = x;
      while (x < f.width && near(px(x, y), TERM)) x++;
      if (!best || x - from > best.w) best = { y, l: from, r: x - 1, w: x - from };
    }
  }
  if (!best || best.w < 40) return null;
  let { y, l, r } = best;
  for (;;) {
    let moved = false;
    for (let k = 1; k <= GAP && l - k >= 0; k++) {
      if (near(px(l - k, y), TERM)) { l -= k; moved = true; break; }
    }
    for (let k = 1; k <= GAP && r + k < f.width; k++) {
      if (near(px(r + k, y), TERM)) { r += k; moved = true; break; }
    }
    if (!moved) break;
  }
  return { y, l, r };
}

/**
 * 표면 위의 머리 행. 카드의 배경색이 세 줄 이어지는 첫 행이다.
 *
 * 표면의 내용에도 카드와 가까운 색이 있을 수 있으므로 한 줄로는 판정하지 않는다.
 */
function headRow(f, run) {
  const cx = Math.round((run.l + run.r) / 2);
  for (let y = run.y; y >= 2; y--) {
    if (near(pixel(f, cx, y), CARD)
      && near(pixel(f, cx, y - 1), CARD)
      && near(pixel(f, cx, y - 2), CARD)) return y - 1;
  }
  return null;
}

/** cx 를 담은, 통로가 아닌 구간. 카드 하나의 바깥 변이다. */
function span(f, y, cx) {
  const px = (x) => pixel(f, x, y);
  if (near(px(cx), PLANE)) return null;
  let l = cx, r = cx;
  while (l > 0 && !near(px(l - 1), PLANE)) l--;
  while (r < f.width - 1 && !near(px(r + 1), PLANE)) r++;
  return { l, r, w: r - l + 1 };
}

/**
 * 한 점이 몇 픽셀인지. 카드의 테두리가 --bw 이고 그 값이 1점이므로, 테두리의 폭이
 * 곧 그 눈금이다. 프레임이 점 단위로 녹화되었는지 픽셀 단위인지 적어 두지 않아도
 * 된다.
 */
function perPoint(f, y, card) {
  const px = (x) => pixel(f, x, y);
  let n = 0;
  for (let k = 0; k < 6 && card.l + k < f.width; k++) {
    if (!any(px(card.l + k), BORDERS)) break;
    n++;
  }
  return n > 0 ? n : 1;
}

/**
 * 이 프레임에서 표면이 자기 카드 밖으로 나간 거리. 점 단위다.
 *
 * 카드의 바깥 사각형과 견준다. 표면의 문서가 자기 배경을 안쪽으로 들여 그리면 이
 * 값은 그만큼 작게 나오므로, 나갔다고 말하는 쪽으로 틀리지 않는다.
 *
 * 잴 수 없는 프레임은 null 이다 — 표면이 이 프레임에 없거나, 머리가 보이지 않거나,
 * 카드를 읽을 수 없는 프레임이다.
 */
export function outside(f) {
  const run = surfaceRun(f);
  if (!run) return null;
  const y = headRow(f, run);
  if (y === null) return null;
  const cx = Math.round((run.l + run.r) / 2);
  const card = span(f, y, cx);
  if (!card || card.w < 40) return null;
  const scale = perPoint(f, y, card);
  const left = (card.l - run.l) / scale;
  const right = (run.r - card.r) / scale;
  // 나간 쪽의 이웃 카드. 통로를 건너 처음 만나는 구간이다. 통로의 폭은 테마가
  // 정하므로 걸어서 찾는다.
  const across = (from, dir) => {
    for (let k = 1; k <= 60; k++) {
      const at = from + dir * k;
      if (at < 1 || at >= f.width - 1) return null;
      if (!near(pixel(f, at, y), PLANE)) return span(f, y, at);
    }
    return null;
  };
  let neighbour = null;
  if (left > 0) neighbour = across(card.l, -1);
  else if (right > 0) neighbour = across(card.r, 1);
  const onNeighbour = neighbour
    ? Math.max(0, Math.min(run.r, neighbour.r) - Math.max(run.l, neighbour.l) + 1) / scale
    : 0;
  return {
    out: Math.max(0, left, right),
    left, right, onNeighbour, scale,
    card: { l: card.l, r: card.r },
    surface: { l: run.l, r: run.r },
    row: y,
  };
}

// 같은 배경의 각 표면을 개별적으로 찾는다. 폭이 일정한 12개 이상의 행이 있는 구간을
// 선택하므로 텍스트의 작은 구멍은 사각형으로 취급하지 않는다.
export function surfaceBoxes(f, colour, { expectedRow, rowTolerance = 40 } = {}) {
  const runs = new Map();
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      if (!near(pixel(f, x, y), colour)) continue;
      const l = x;
      while (x < f.width && near(pixel(f, x, y), colour)) x++;
      if (x - l < 20) continue;
      const key = `${l}:${x}`;
      const held = runs.get(key);
      if (held) { held.b = y + 1; held.rows++; }
      else runs.set(key, { l, r: x, t: y, b: y + 1, rows: 1 });
    }
  }
  const candidates = [...runs.values()].filter((r) => r.rows >= 12)
    .sort((a, b) => (b.r - b.l) * b.rows - (a.r - a.l) * a.rows);
  const boxes = [];
  for (const r of candidates) {
    // 브라우저 문서처럼 같은 배경색을 쓰는 다른 행은 호출자가 선언한
    // 터미널 행 측정 범위 밖이다. 범위 안의 후보는 계속 검증하고 실패를 숨기지 않는다.
    if (expectedRow !== undefined && Math.abs(r.t / f.scale - expectedRow) > rowTolerance) continue;
    if (boxes.some((b) => r.l < b.r && r.r > b.l && r.t < b.b && r.b > b.t)) continue;
    const row = headRow(f, { ...r, y: r.t });
    if (row === null) throw new Error(`content at ${r.l},${r.t} has no DOM header`);
    const card = span(f, row, Math.floor((r.l + r.r) / 2));
    if (!card) throw new Error(`content at ${r.l},${r.t} has no DOM card`);
    const sameCard = boxes.find((b) => b.card.l === card.l && b.card.r === card.r && b.row === row);
    if (sameCard) {
      sameCard.l = Math.min(sameCard.l, r.l);
      sameCard.r = Math.max(sameCard.r, r.r);
      sameCard.t = Math.min(sameCard.t, r.t);
      sameCard.b = Math.max(sameCard.b, r.b);
    } else boxes.push({ ...r, card, row });
  }
  return boxes.sort((a, b) => a.t - b.t || a.l - b.l);
}

// 지정 영역의 흰 픽셀을 전부 센다. 면적 비율로 작은 결함을 허용하지 않는다.
export function whitePixels(frame, { l, r, t, b }) {
  if (!(l >= 0 && t >= 0 && r <= frame.width && b <= frame.height && r > l && b > t)) {
    throw new Error("invalid pixel measurement rectangle");
  }
  let count = 0;
  for (let y = t; y < b; y++) {
    for (let x = l; x < r; x++) {
      if (pixel(frame, x, y).every((v) => v >= 245)) count++;
    }
  }
  return count;
}

// 글리프 하나의 밝은 픽셀 경계와 면적을 읽는다. 위치 이동과 글자 크기 변경을 구별한다.
export function glyphShape(frame, { l, r, t, b }) {
  let left = r, right = l, top = b, bottom = t, count = 0;
  for (let y = t; y < b; y++) for (let x = l; x < r; x++) {
    if (!pixel(frame, x, y).every((v) => v > 100)) continue;
    count++;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (!count) throw new Error(`no glyph pixels in ${l},${t}..${r},${b}`);
  return { width: right-left+1, height: bottom-top+1, count };
}
