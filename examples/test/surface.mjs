// 프레임 안에서 터미널 표면을 찾는다.
//
// 표면의 배경색은 settings.js 의 midnight 테마가 --surface 로 주는 값이고, 예제가
// 기본으로 그리는 테마다. 브라우저 표면은 흰 문서를 그리므로 이 색이 아니다.
import { pixel } from "./frame.mjs";

/** 터미널 표면의 배경색. */
const SURFACE = [13, 26, 20];

/**
 * 이만큼 벗어난 색은 표면이 아니다.
 *
 * "어두운 초록" 처럼 넓게 잡으면 판의 배경 #101117 과 카드 테두리 #2b2e3d 가 함께
 * 걸린다. 이 검사가 찾는 것은 터미널 표면이므로 그 색만 본다.
 */
const NEAR = 4;

/** 흰색으로 판정할 밝기. */
const PALE = 230;

/**
 * 표면 배경과 흰색이 이만큼 안에 맞붙어 있으면 사이에 카드 테두리가 없다.
 *
 * midnight 테마의 통로는 6px 이다. 그만큼 멀리 보면 통로 건너편 표면이 걸리므로
 * 통로보다 짧아야 한다.
 */
const REACH = 3;

const surface = (px) => px.every((v, i) => Math.abs(v - SURFACE[i]) <= NEAR);
const pale = ([r, g, b]) => r > PALE && g > PALE && b > PALE;

/**
 * 이 프레임에서 터미널 표면에 맞붙은 흰 픽셀 수.
 *
 * 터미널 표면의 배경 바로 옆은 카드의 머리, 발, 테두리라 모두 어둡다. 그 배경에
 * 맞붙은 흰색은 그 표면 안에서 아직 렌더링되지 않은 자리뿐이다. 창의 어느 구역인지
 * 알 필요가 없으므로 세로 끌기와 가로 끌기에 같은 기준이 쓰인다.
 */
export function bare(frame) {
  let n = 0;
  for (let y = REACH; y < frame.height - REACH; y += 2) {
    for (let x = REACH; x < frame.width - REACH; x += 2) {
      if (!surface(pixel(frame, x, y))) continue;
      if (pale(pixel(frame, x + REACH, y)) || pale(pixel(frame, x - REACH, y)) ||
          pale(pixel(frame, x, y + REACH)) || pale(pixel(frame, x, y - REACH))) {
        n++;
      }
    }
  }
  return n;
}

/**
 * 이 프레임에서 터미널 표면이 차지한 넓이. 두 픽셀마다 하나씩 센 값이다.
 *
 * 경계가 움직이면 그 경계에 접한 터미널 카드가 커지거나 작아지므로 이 값이 바뀐다.
 */
export function area(frame) {
  let n = 0;
  for (let y = 0; y < frame.height; y += 2) {
    for (let x = 0; x < frame.width; x += 2) {
      if (surface(pixel(frame, x, y))) n++;
    }
  }
  return n;
}
