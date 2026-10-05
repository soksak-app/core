// 프레임 안에서 렌더링되지 않은 표면 영역과 터미널 카드의 크기를 잰다.
//
// 터미널 표면의 기본 배경은 카드와 같은 색(--card)이다(terminal.test.mjs 의 배경 검사). midnight 테마에서 창의 어느 것도
// 흰색이 아니므로, 카드 색에 맞붙은 흰 픽셀은 웹뷰가 아직 렌더링하지 않은 자리다.
import { pixel } from "@soksak/window-check/frame.mjs";

/** 카드와 터미널 표면의 기본 배경. midnight 테마의 --card(#191b24)다. */
const CARD = [25, 27, 36];

/** 판의 배경. 카드 사이의 통로가 이 색이다. midnight 테마의 --bg(#101117). */
const PLANE = [16, 17, 23];

/** 이만큼 벗어난 색은 그 색이 아니다. */
const NEAR = 4;

/**
 * 흰색으로 판정할 밝기. 카드의 글자 색 --fg(#ececf5)는 빨강과 초록이 236 이므로, 렌더링되지 않은 흰색(255)만
 * 이 값을 넘는다.
 */
const PALE = 248;

/**
 * 카드 색과 흰색이 이만큼 안에 맞붙어 있으면 사이에 카드 테두리가 없다.
 *
 * midnight 테마의 통로는 6px 이다. 그만큼 멀리 보면 통로 건너편 카드가 걸리므로 통로보다 짧아야 한다.
 */
const REACH = 3;

const near = (px, colour) => px.every((v, i) => Math.abs(v - colour[i]) <= NEAR);
const pale = ([r, g, b]) => r > PALE && g > PALE && b > PALE;

/**
 * 이 프레임에서 카드 색에 맞붙은 흰 픽셀 수.
 *
 * 카드와 표면의 배경 바로 옆은 카드의 머리, 발, 테두리라 모두 어둡다. 그 배경에 맞붙은 흰색은 표면 안에서
 * 아직 렌더링되지 않은 자리뿐이다. 창의 어느 구역인지 알 필요가 없으므로 세로 끌기와 가로 끌기에 같은 기준이
 * 쓰인다.
 */
export function bare(frame) {
  let n = 0;
  for (let y = REACH; y < frame.height - REACH; y += 2) {
    for (let x = REACH; x < frame.width - REACH; x += 2) {
      if (!near(pixel(frame, x, y), CARD)) continue;
      if (pale(pixel(frame, x + REACH, y)) || pale(pixel(frame, x - REACH, y)) ||
          pale(pixel(frame, x, y + REACH)) || pale(pixel(frame, x, y - REACH))) {
        n++;
      }
    }
  }
  return n;
}

/**
 * 터미널 카드의 폭과 높이(점). 카드 머리의 한 점(점 단위의 x, y)에서 좌우와 아래로 통로가 나올 때까지 걷는다.
 * 터미널 카드의 왼쪽이나 아래 경계를 끄는 동안 그 점은 카드 안에 있다. 잴 수 없으면 null 이다.
 */
export function cardSize(frame, { x, y }) {
  const cx = Math.round(x * frame.scale), cy = Math.round(y * frame.scale);
  const plane = (px, py) => near(pixel(frame, px, py), PLANE);
  // 카드가 근처에 아직 있어도 compositor 가장자리가 선언된 probe를 덮을 수 있다.
  // 근처의 device pixel을 시도한다. 실제로 없는 카드는
  // 측정할 수 없는 상태로 남는다.
  const candidates = [cx, cx - 1, cx + 1, cx - 2, cx + 2, cx - 8, cx + 8, cx - 16, cx + 16]
    .filter((probe) => probe >= 0 && probe < frame.width && !plane(probe, cy));
  let best = null;
  for (const probe of candidates) {
    const walk = (start, step, limit, at) => {
      let position = start;
      let solid = start;
      let gap = 0;
      while (position + step >= 0 && position + step < limit) {
        const next = position + step;
        if (!plane(next, at)) {
          position = next;
          solid = next;
          gap = 0;
          continue;
        }
        if (++gap > 4) break;
        position = next;
      }
      return solid;
    };
    const l = walk(probe, -1, frame.width, cy);
    const r = walk(probe, 1, frame.width, cy);
    let b = cy;
    while (b + 1 < frame.height && !plane(probe, b + 1)) b++;
    const measured = { width: (r - l + 1) / frame.scale, height: (b - cy + 1) / frame.scale };
    if (best === null || measured.width > best.width) best = measured;
  }
  return best;
}
