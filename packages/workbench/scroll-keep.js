// 다시 그려도 같은 내용이면 스크롤 위치를 유지한다(docs/spec/settings.md). 스크롤하는 요소는 data-scroll-key 로
// 보이는 내용을 밝힌다. 키가 같으면 같은 내용이고, 키가 다르면 맨 위에서 시작한다.

/** root 안의 data-scroll-key 요소마다 스크롤 위치를 키별로 읽는다. */
export function scrollPositions(root) {
  const positions = new Map();
  for (const element of root.querySelectorAll("[data-scroll-key]")) {
    positions.set(element.dataset.scrollKey, { top: element.scrollTop, left: element.scrollLeft });
  }
  return positions;
}

/** root 안의 data-scroll-key 요소 가운데 positions 에 같은 키가 있는 요소의 위치를 되돌린다. */
export function restoreScroll(root, positions) {
  for (const element of root.querySelectorAll("[data-scroll-key]")) {
    const position = positions.get(element.dataset.scrollKey);
    if (!position) continue;
    element.scrollTop = position.top;
    element.scrollLeft = position.left;
  }
}
