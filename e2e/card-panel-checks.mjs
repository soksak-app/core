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
  return poses.filter((pose, index) => !frames.some((frame) => frame.time >= start(pose, index) - 1 &&
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

/** top 이나 bottom 패널의 DOM 폭이 카드 안쪽 폭(카드 폭에서 양쪽 테두리를 뺀 값)과 같아야 한다. */
export function requireFullWidth(rect, card, border, side) {
  const inner = card.w - 2 * border;
  assert.ok(Math.abs(rect.width - inner) <= 1, `${side} panel is ${rect.width} wide, not the card's inner width ${inner}`);
}
