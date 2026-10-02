import { pixel } from "./frame.mjs";

// 카드 사이 간격의 배경. midnight 테마의 --bg(#101117)다.
const PAGE = [16, 17, 23];

// 셸 카드 왼쪽의 고정 사이드바 카드 배경과, 셸 카드를 오른쪽 고정 사이드바와 묶는 레일을 측정한다. 셸 표면의
// 가로 구간과 측정 행은 at 으로 받는다(outside.mjs 의 셸 입력 구분선). 레일은 셸 카드의 행에서만 셸 카드의 왼쪽
// 가장자리를 지나므로 그 행에서 잰다. 측정하지 못하면 측정하지 못한 항목과 그 자리의 픽셀을 missing 으로 반환한다.
export function alignment(frame, at) {
  const y = at.row;
  // 사이드바 카드는 내용에 따라 머리와 행의 색이 다르므로, 간격 배경이 시작되기 전까지를 사이드바로 본다.
  const page = (x) => pixel(frame, x, y).every((value, i) => Math.abs(value - PAGE[i]) <= 5);
  let x = Math.round(at.card.l - 20 * at.scale);
  if (x < 0 || page(x)) {
    return { missing: `sidebar card left of the gap ${JSON.stringify(PAGE)} at ${x},${y}` + (x < 0 ? "" : `: ${JSON.stringify(pixel(frame, x, y))}`) };
  }
  while (x + 1 < frame.width && !page(x + 1)) x++;
  const sidebar = x;
  let ink = 0, rail = null;
  for (let k = x + 1; k <= x + 20 * at.scale && k < frame.width; k++) {
    const [r, g, b] = pixel(frame, k, y);
    const weight = b - Math.max(r, g);
    if (weight <= 25 || weight <= ink) continue;
    ink = weight;
    rail = k;
  }
  if (!ink) return { missing: `rail ink right of the sidebar edge ${x} at row ${y}` };
  return {
    contentLeft: -at.left,
    contentRight: -at.right,
    sidebar: (at.card.l - sidebar) / at.scale,
    rail: (at.card.l - rail) / at.scale,
  };
}

/**
 * 처음 측정한 배치와 이 프레임의 배치가 다른 가장 큰 거리(점). 터미널은 크기가 바뀌는 동안 이전 크기의 래스터를
 * 왼쪽에 붙여 보이므로 오른쪽 안쪽 여백(contentRight)은 커질 수 있다. 그 여백은 터미널의 평소 배경인 카드 색이고,
 * 정렬이 막으려는 것은 내용이 카드 밖으로 나가거나 왼쪽 끝이 움직이는 것이므로 그 여백이 줄어든 만큼만 센다.
 */
export function alignmentDelta(initial, geometry) {
  return Math.max(...Object.keys(initial).map((key) => key === "contentRight"
    ? Math.max(0, initial[key] - geometry[key])
    : Math.abs(geometry[key] - initial[key])));
}
