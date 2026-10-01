import assert from "node:assert/strict";

// 실제 캡처 좌표로 왕복 횟수와 시작점 복귀를 확인한다. 정지한 화면은 통과할 수 없다.
//
// 페이지는 기다리는 배치 중 가장 새 것만 표시하므로(docs/spec/native-surfaces.md), 한 번의 표시보다 짧게
// 머문 위치는 대신될 수 있다. 끌기는 왕복 사이에 시작 위치에 한 걸음만 머물므로 그 위치는 보이지 않을 수
// 있다. 녹화는 처음과 마지막에 시작 쪽 끝에 있고, 먼 끝에는 왕복마다 한 번 도달해야 한다.
export function assertRoundTrips(positions, times) {
  assert.ok(positions.length > 1 && positions.every(Number.isFinite), "drag positions are missing or invalid");
  const low = Math.min(...positions), high = Math.max(...positions);
  const span = high - low;
  assert.ok(span >= 50, `the card moved only ${span}pt; the requested drag was not recorded`);
  const end = (position) => position <= low + span * .2 ? "low" : position >= high - span * .2 ? "high" : null;
  const start = end(positions[0]);
  assert.ok(start && end(positions.at(-1)) === start,
    `the recording must start and end at the start end; positions: ${positions.join(",")}`);
  const far = start === "low" ? "high" : "low";
  let visits = 0;
  let inside = false;
  for (const position of positions) {
    const now = end(position) === far;
    if (now && !inside) visits++;
    inside = now;
  }
  assert.equal(visits, times,
    `expected the far end once in each of ${times} round trips, observed ${visits}; positions: ${positions.join(",")}`);
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
  // 기본값: 측정한 프레임이 없으면 지연도 없다(0).
  const at = (fraction) => lags[Math.min(lags.length - 1, Math.floor(lags.length * fraction))] ?? 0;
  return { ...worst, median: at(0.5), p90: at(0.9) };
}

/**
 * 가장 늦은 프레임의 지연을 배치 트랜잭션 단계로 나눈다.
 *
 * lag 는 pointerLag 의 결과, layouts 는 호스트가 기록한 { ticket, begun, presented, committed }(ms, 프레임과
 * 같은 시계) 목록이다. 격자가 그 배치를 떠난 걸음의 시각부터 그 프레임의 표시 시각 사이에 열려 있던
 * 트랜잭션마다, 떠난 시각에서 각 단계까지의 시간을 적는다. 페이지는 앞선 트랜잭션의 답을 받은 뒤 다음
 * 준비를 시작하므로(docs/spec/native-surfaces.md) 그때 이미 열려 있던 트랜잭션도 포함한다.
 */
export function lagStages(lag, ticks, layouts) {
  if (!lag.time || !Array.isArray(layouts)) return "no layout trace";
  const left = ticks[lag.step + 1];
  const at = (value) => (value === null ? "-" : `+${(value - left).toFixed(1)}`);
  // 프레임 뒤에 처음 시작한 트랜잭션도 적는다. 그 사이 페이지가 준비를 시작하지 않은 시간이 보인다.
  const next = layouts.find(({ begun }) => begun !== null && begun > lag.time);
  // 대신된 트랜잭션은 커밋 시각이 없으므로 마지막 단계의 시각으로 끝났는지 본다.
  const open = layouts.filter(({ begun, presented, committed }) =>
    begun !== null && begun <= lag.time && (committed ?? presented ?? Infinity) >= left).concat(next ? [next] : []);
  const stages = open.map(({ ticket, begun, presented, committed }) =>
    `#${ticket} begun ${at(begun)} presented ${at(presented)} committed ${at(committed)}`);
  return `step ${lag.step + 1} at ${left.toFixed(1)}ms, frame at +${(lag.time - left).toFixed(1)}: ${stages.join("; ") || "no transaction"}`;
}

/** 녹화에 반드시 나와야 하는 상태의 최소 유지 시간(ms). 60Hz 화면의 두 프레임이다. */
const HOLD = 34;

/**
 * 한 번의 표시보다 오래 유지된 배치가 녹화에 나왔는지 확인한다.
 *
 * 페이지는 기다리는 배치 중 가장 새 것만 표시하므로(docs/spec/native-surfaces.md) 짧게 머문 위치는 대신될
 * 수 있다. boundary 와 ticks 로 걸음마다 경계가 머문 시간을 계산하고, HOLD 이상 머문 위치(끌기 전과 끝난 뒤의
 * 위치 포함)는 그 위치에 들어선 뒤의 녹화 프레임에 나와야 한다. samples 는 { time, position } 이고 첫 항목이
 * 끌기 전 위치다.
 */
export function assertHeldStatesShown(samples, ticks, boundary, hold = HOLD) {
  assert.ok(Array.isArray(ticks) && ticks.length > 0, "the host reported no step times");
  assert.equal(boundary?.length, ticks.length + 1,
    `the page reported ${boundary?.length} boundary positions for ${ticks.length} steps`);
  const base = samples[0].position;
  const values = boundary.map((value) => value - boundary[0]);
  // 상태 i 는 values[i] 이고, i 번째 걸음(ticks[i-1])부터 다음 걸음까지 유지된다.
  const segments = [];
  for (let i = 0; i < values.length; i++) {
    const start = i === 0 ? -Infinity : ticks[i - 1];
    const end = i < ticks.length ? ticks[i] : Infinity;
    const last = segments.at(-1);
    if (last && Math.abs(last.value - values[i]) <= 1) last.end = end;
    else segments.push({ value: values[i], start, end });
  }
  const missing = segments.filter((segment) => segment.end - segment.start >= hold).filter((segment) =>
    !samples.some(({ time, position }) => time >= segment.start && Math.abs(position - base - segment.value) <= 1));
  assert.deepEqual(missing.map(({ value, start, end }) => ({ value, held: end - start })), [],
    `layouts held for ${hold}ms or longer are missing from the recording; ` +
    `recorded offsets: ${samples.map(({ position }) => (position - base).toFixed(0)).join(",")}`);
}
