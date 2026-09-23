import { pixel } from "./frame.mjs";

// 셸 입력 구분선의 실측 색. CSS의 22% color-mix가 1px 경계의 반 픽셀
// 래스터화와 함께 --surface(#0d1a14)에 합성된 결과다(plugins/shell/ui/shell.js).
const LINE = [26, 49, 37];

// 셸 입력 구분선은 웹뷰 배경과 별도로 문서의 실제 표시 폭을 확인한다.
function shellLine(frame, at) {
  const cx = Math.round((at.surface.l + at.surface.r) / 2);
  let best = null;
  for (let y = at.row + 3; y < frame.height * .6; y++) {
    const line = (x) => pixel(frame, x, y).every((value, i) => Math.abs(value - LINE[i]) <= 5);
    if (!line(cx)) continue;
    let l = cx, r = cx;
    while (l > 0 && line(l - 1)) l--;
    while (r + 1 < frame.width && line(r + 1)) r++;
    if (!best || r - l > best.r - best.l) best = { l, r };
  }
  return best && best.r - best.l > 40 ? best : null;
}

// 카드의 배경. midnight 테마의 --card(#191b24)다.
const CARD = [25, 27, 36];

// 초기 배치의 레일 사이드바 아래쪽에서 카드 배경과 외곽 레일을 측정한다. 측정하지 못하면
// 측정하지 못한 항목과 그 자리의 픽셀을 missing 으로 반환한다.
export function alignment(frame, at) {
  const line = shellLine(frame, at);
  if (!line) return { missing: `shell line ${JSON.stringify(LINE)} below row ${at.row} at x ${Math.round((at.surface.l + at.surface.r) / 2)}` };
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
    lineLeft: (line.l - at.card.l) / at.scale,
    lineRight: (at.card.r - line.r) / at.scale,
    sidebar: (at.card.l - sidebar) / at.scale,
    rail: (at.card.l - rail) / at.scale,
  };
}
