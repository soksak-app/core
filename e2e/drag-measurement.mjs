import assert from "node:assert/strict";

// 실제 캡처 좌표로 왕복 횟수와 시작점 복귀를 확인한다. 정지한 화면은 통과할 수 없다.
export function assertRoundTrips(positions, times) {
  assert.ok(positions.length > 1 && positions.every(Number.isFinite), "drag positions are missing or invalid");
  const low = Math.min(...positions), high = Math.max(...positions);
  const span = high - low;
  assert.ok(span >= 50, `the card moved only ${span}pt; the requested drag was not recorded`);
  const ends = [];
  for (const position of positions) {
    const end = position <= low + span * .2 ? "low" : position >= high - span * .2 ? "high" : null;
    if (end && ends.at(-1) !== end) ends.push(end);
  }
  assert.equal(ends.length, times * 2 + 1,
    `expected ${times} complete round trips, observed ${ends.join(",")}; positions: ${positions.join(",")}`);
  assert.equal(ends[0], ends.at(-1), "the recorded drag did not return to its starting end");
  assert.ok(Math.abs(positions[0] - positions.at(-1)) <= 1,
    `the recorded card must return to its initial position: ${positions[0]} → ${positions.at(-1)}`);
  return span;
}

/**
 * 녹화 프레임마다 카드 위치가 포인터보다 얼마나 늦었는지(ms)를 잰다.
 *
 * samples 는 { time, position }(포인트) 목록이고 첫 항목이 끌기 전 위치다. ticks 는
 * 호스트가 걸음을 보낸 시각이며 프레임과 같은 시계다. boundary 는 페이지가 보고한
 * 경계 위치로, 첫 값이 끌기 전이고 k+1 번째 값이 걸음 k 뒤다. 경계는 이웃 선에 붙거나
 * 최소 크기에서 멈추므로 포인터 오프셋 대신 이 값으로 프레임의 배치를 걸음에 맞춘다.
 * 프레임이 보여준 배치를 격자가 마지막으로 떠난 시각부터 그 프레임의 표시 시각까지가
 * 지연이다. 격자가 아직 그 배치에 있으면 지연은 0 이다. 어떤 걸음과도 맞지 않는
 * 위치는 측정할 수 없으므로 실패한다.
 */
export function pointerLag(samples, ticks, boundary) {
  assert.ok(Array.isArray(ticks) && ticks.length > 0, "the host reported no step times");
  assert.equal(boundary?.length, ticks.length + 1,
    `the page reported ${boundary?.length} boundary positions for ${ticks.length} steps`);
  const moved = (k) => boundary[k + 1] - boundary[0];
  const base = samples[0].position;
  let worst = { lag: 0, time: null, shown: null, step: null, sent: null };
  const lags = [];
  for (const { time, position } of samples) {
    if (time < ticks[0]) continue;
    const shown = position - base;
    let k = ticks.length - 1;
    while (k >= 0 && ticks[k] > time) k--;
    const sent = k;
    while (k >= 0 && Math.abs(moved(k) - shown) > 1) k--;
    if (k < 0 && Math.abs(shown) > 1) {
      assert.fail(`the card offset ${shown.toFixed(1)}pt at ${time.toFixed(1)}ms matches no step sent before it ` +
        `(last step ${sent}, boundary offset ${moved(sent).toFixed(1)}pt)`);
    }
    // k 는 이 배치를 가진 마지막 걸음이므로 격자는 걸음 k+1 에서 이 배치를 떠났다.
    const lag = k < sent ? time - ticks[k + 1] : 0;
    lags.push(lag);
    if (lag > worst.lag) worst = { lag, time, shown, step: k, sent };
  }
  lags.sort((a, b) => a - b);
  return { ...worst, median: lags[Math.floor(lags.length / 2)] ?? 0 };
}
