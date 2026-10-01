// 검증의 계산 중 판과 컴포지터를 읽지 않는 부분. verify.js 가 판에서 읽은 값을 넘긴다.
import { isPlace } from "./registry.js";
import { windowSidebar } from "./window-sidebars.js";

/**
 * 레일 묶음마다 이어진 사각형 무리의 수를 더해, 레일 외곽선이 가져야 할 닫힌 고리 수를 반환한다.
 * 두 사각형은 가로·세로 간격이 모두 gap(+0.5) 이하일 때 이어진다.
 */
export function expectedRailLoops(groups, gap) {
  let loops = 0;
  for (const group of groups) {
    const pending = new Set(group.rects.map((_,index) => index));
    while (pending.size) {
      loops++;
      const work = [pending.values().next().value];
      pending.delete(work[0]);
      while (work.length) {
        const a = group.rects[work.pop()];
        for (const index of [...pending]) {
          const b = group.rects[index];
          const dx = Math.max(b.x-(a.x+a.w),a.x-(b.x+b.w));
          const dy = Math.max(b.y-(a.y+a.h),a.y-(b.y+b.h));
          if (dx <= gap+.5 && dy <= gap+.5) { pending.delete(index); work.push(index); }
        }
      }
    }
  }
  return loops;
}

/**
 * 창 사이드바의 배치와 폭을 검증한다. 선언값이 아니라 그려진 폭을 잰다. 선언값은 요청이고 검증 대상은 결과다.
 * 각 쪽에는 사이드바가 하나이며, 그 쪽 가장자리 열에 전체 높이로 서고 저장 폭을 넘지 않는다.
 */
export function windowSidebarsPlaced(grid) {
  const places = grid.cards.filter(card => isPlace(card.id));
  const extent = card => card.width === undefined || grid.rect(card.id).w <= card.width + .5;
  const fullHeight = card => card.fixed && card.r0 === 0 && card.r1 === grid.lines("y").length-1;
  let placeOk = places.every(card => extent(card) && fullHeight(card));
  for (const side of ["left", "right"]) {
    const cardsOnSide = places.filter(card => windowSidebar(card.id).side === side).sort((a,b) => a.c0-b.c0);
    if (!cardsOnSide.length) continue;
    placeOk &&= cardsOnSide.length === 1;
    placeOk &&= side === "left" ? cardsOnSide[0].c0 === 0 : cardsOnSide.at(-1).c1 === grid.lines("x").length-1;
    placeOk &&= cardsOnSide.every((card,index) => index === 0 || cardsOnSide[index-1].c1 === card.c0);
  }
  return placeOk;
}
