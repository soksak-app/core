// 카드 패널 window check 의 판정. 판정이 잘못된 입력을 거부하는지 test/card-panel-checks.test.mjs 가 검사한다.
import assert from "node:assert/strict";

/**
 * 녹화에서 빠진 표시 상태. frames 는 { time, edges }(표시 시각 ms, 그 프레임에서 잰 경계 좌표), poses 는
 * { displayed, at }(표시 시각 ms, 그 상태의 경계 좌표)다. 상태가 표시된 뒤 화면 두 프레임 안에 그 경계를 담은
 * 프레임이 없으면 요청한 rate 로 녹화하지 못한 것이다.
 */
export function missingPoses(frames, poses, refreshRate) {
  assert.ok(Number.isFinite(refreshRate) && refreshRate > 0, `the display refresh rate is unknown (${refreshRate})`);
  const window = 2000 / refreshRate;
  // 녹화가 시작되기 전의 프레임은 없다. 녹화 시작 전에 표시되어 첫 프레임까지 바뀌지 않은 상태는 첫 프레임부터
  // 센다. 녹화 시작 전에 다음 상태로 바뀐 상태는 녹화될 수 없으므로 원래 시각으로 센다.
  const first = Math.min(...frames.map((frame) => frame.time));
  const start = (pose, index) => {
    const next = poses[index + 1];
    const replaced = next !== undefined && next.displayed < first;
    return pose.displayed < first && !replaced ? first : pose.displayed;
  };
  // 보고된 표시 시각은 상태가 화면에 처음 나타난 refresh 보다 늦을 수 있다(host.window.presented 는 응답 뒤의
  // refresh 다). 그래서 이전 상태가 표시된 뒤부터 이 상태의 표시 뒤 두 화면 프레임까지의 프레임을 본다. 이전 상태가
  // 표시되기 전의 프레임은 더 이른 상태의 기록이다.
  const after = (index) => (index === 0 ? -Infinity : poses[index - 1].displayed - 1);
  return poses.filter((pose, index) => !frames.some((frame) => frame.time >= after(index) &&
    frame.time <= start(pose, index) + window && frame.edges.some((edge) => Math.abs(edge - pose.at) <= 1)));
}

/** 패널을 모두 끈 뒤 남은 패널이 있으면 실패한다. 남은 기본 패널도 실패다. */
export function requireCleared(sidebars) {
  const left = Object.keys(sidebars);
  assert.deepEqual(left, [], `panels remained after clearing: ${left.join(", ")}`);
}

/**
 * 탭 전환 검사에 쓸 탭 쌍. card 의 활성 탭과 다른 플러그인의 탭을 card 나 다른 카드에서 찾는다. 다른 카드에서 찾으면
 * from 에 그 카드 id 를 담는다. 다른 플러그인의 탭이 없으면 검사할 수 없으므로 실패한다.
 */
export function tabSwitchPair(card, cards) {
  const original = card.tabs.find((tab) => tab.id === card.active);
  const own = card.tabs.find((tab) => tab.plugin !== original.plugin);
  if (own) return { original, other: own, from: card.id };
  const source = cards.find((item) => item.id !== card.id && item.tabs.some((tab) => tab.plugin !== original.plugin));
  assert.ok(source, `no tab of a plugin other than ${original.plugin} exists for the tab switch`);
  return { original, other: source.tabs.find((tab) => tab.plugin !== original.plugin), from: source.id };
}

/**
 * top 이나 bottom 패널의 DOM 폭이 카드의 내용 열 폭(카드 안쪽 폭에서 좌·우 사이드바가 차지한 폭을 뺀 값)과 같아야
 * 한다(docs/spec/example-model.md). 접힌 면은 divider 폭을 차지한다.
 */
export function requireContentWidth(rect, card, border, divider, side) {
  // 기본값: 없는 면은 폭을 차지하지 않는다.
  const extent = (state) => (state ? (state.collapsed ? divider : state.shownSize) : 0);
  const column = card.w - 2 * border - extent(card.sidebars?.left) - extent(card.sidebars?.right);
  assert.ok(Math.abs(rect.width - column) <= 1, `${side} panel is ${rect.width} wide, not the card's content column width ${column}`);
}

/**
 * 접힌 카드 패널 grip 사각형(CSS 픽셀) 안에서, 긴 축의 가운데 줄을 따라 띠 안 배경과 다른 픽셀이 이어진
 * 가장 긴 길이, 그 픽셀 수, 이어진 구간의 수(runs)와 첫 잉크에서 마지막 잉크까지의 길이(span)(장치 픽셀).
 * image 는 readPng 의 결과이고 ratio 는 장치 픽셀 / CSS 픽셀이다.
 */
export function gripInk(image, rect, ratio, threshold = 16) {
  const vertical = rect.height > rect.width;
  const from = Math.ceil((vertical ? rect.y : rect.x) * ratio);
  const to = Math.floor(((vertical ? rect.y + rect.height : rect.x + rect.width)) * ratio);
  const middle = Math.floor(((vertical ? rect.x + rect.width / 2 : rect.y + rect.height / 2)) * ratio);
  // 띠의 바깥 끝은 카드 테두리와 겹칠 수 있으므로 가운데에서 2 CSS 픽셀 떨어진 띠 안의 픽셀을 배경으로 쓴다.
  const edge = middle - Math.round(2 * ratio);
  let run = 0, longest = 0, total = 0, runs = 0, first = -1, last = -1;
  for (let at = from; at < to; at++) {
    const [x, y, ex, ey] = vertical ? [middle, at, edge, at] : [at, middle, at, edge];
    const ink = image.pixel(x, y).some((value, index) => Math.abs(value - image.pixel(ex, ey)[index]) > threshold);
    if (ink && run === 0) runs++;
    run = ink ? run + 1 : 0;
    longest = Math.max(longest, run);
    if (ink) {
      total++;
      if (first < 0) first = at;
      last = at;
    }
  }
  return { longest, total, runs, span: first < 0 ? 0 : last - first + 1, length: to - from };
}

