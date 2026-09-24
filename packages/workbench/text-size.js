// 글자 크기의 단계와 범위. docs/spec/text-size.md
//
// 범위는 사용자가 마지막으로 누른 곳이다. 카드를 누르면 그 카드, 판 밖의 프레임을 누르면
// 프레임이다. 아직 누르지 않았으면 null 이고, 그때는 포커스된 카드가 범위다.

/** 글자 크기 배율의 단계. */
export const TEXT_STEPS = Object.freeze([0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]);

/**
 * value 에서 direction 으로 옮긴 배율. 1 은 다음 큰 단계, -1 은 다음 작은 단계, 0 은 1 이다.
 * 끝 단계에서 더 옮기면 값은 그대로다. 단계에 없는 값과 다른 방향은 오류다.
 */
export function nextTextSize(value, direction) {
  if (direction !== 1 && direction !== -1 && direction !== 0) {
    throw new Error(`text size direction ${direction} is invalid`);
  }
  const index = TEXT_STEPS.indexOf(value);
  if (index < 0) throw new Error(`text size ${value} is not a step`);
  if (direction === 0) return 1;
  return TEXT_STEPS[Math.min(TEXT_STEPS.length - 1, Math.max(0, index + direction))];
}

let scope = null;
const listeners = new Set();

/** 현재 범위. {kind: "card", card} 이거나 {kind: "frame"} 이며, 누르기 전에는 null 이다. */
export const textScope = () => scope;

/** 범위를 바꾸고 알린다. */
export function setTextScope(next) {
  if (next?.kind === "card") {
    if (typeof next.card !== "string" || !next.card) throw new Error("a card text scope requires a card");
    scope = { kind: "card", card: next.card };
  } else if (next?.kind === "frame") {
    scope = { kind: "frame" };
  } else {
    throw new Error(`text scope ${JSON.stringify(next)} is invalid`);
  }
  for (const fn of listeners) fn(scope);
}

/** 범위가 바뀔 때 호출할 함수를 등록한다. 등록을 끝내는 함수를 반환한다. */
export function onTextScope(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
