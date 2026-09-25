import { pixel } from "./frame.mjs";

// 카드의 배경. midnight 테마의 --card(#191b24)다.
const CARD = [25, 27, 36];

// 초기 배치의 레일 사이드바 아래쪽에서 카드 배경과 외곽 레일을 측정한다. 셸 표면의 가로 구간은 at.surface 로
// 받는다(outside.mjs 의 셸 입력 구분선). 측정하지 못하면 측정하지 못한 항목과 그 자리의 픽셀을 missing 으로
// 반환한다.
export function alignment(frame, at) {
  const y = Math.floor(frame.height * .75);
  const card = (x) => pixel(frame, x, y).every((value, i) => Math.abs(value - CARD[i]) <= 5);
  let x = Math.round(at.card.l - 20 * at.scale);
  if (x < 0 || !card(x)) {
    return { missing: `sidebar card ${JSON.stringify(CARD)} at ${x},${y}` + (x < 0 ? "" : `: ${JSON.stringify(pixel(frame, x, y))}`) };
  }
  while (x + 1 < frame.width && card(x + 1)) x++;
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
