// 페이지의 성능 트레이스 생산자(V5-104, docs/spec/performance-trace.md).
//
// 페이지는 파일이 없으므로 자기 줄을 host.performance 의 line 동작으로 호스트에
// 중계한다. ts 는 페이지 시계로 찍고 계층은 호스트가 page 로 못박는다. JS 힙을
// 잴 수 있으면 매 줄에 함께 싣는다 — 페이지 몫의 메모리를 웹킷 몫과 가른다.
import { host as bridge } from "@soksak/runtime";

const defaultSend = (line) => {
  bridge?.call("performance", { action: "line", line }).then(undefined, () => {});
};

/**
 * 한 페이지 이벤트 줄을 트레이스에 남긴다. 호스트가 없는 문서(검사 문맥)와 꺼진
 * 트레이스에서는 조용히 끝난다 — 꺼진 트레이스는 호스트가 거부하고, 여기서 그
 * 거부를 삼키는 것은 오류를 숨기는 게 아니라 스위치가 꺼져 있다는 뜻이다.
 */
export function trace(event, fields = {}, send = defaultSend) {
  const line = { ts: new Date().toISOString(), event, ...fields };
  const memory = globalThis.performance?.memory;
  if (memory) line.jsHeapMB = Math.round(memory.usedJSHeapSize / 1048576);
  send(line);
}

/** 명령 하나의 시간을 잰다. answer 가 돌아가는 값을 그대로 돌려준다. */
export async function timed(name, answer, send = defaultSend) {
  const started = performance.now();
  try {
    const result = await answer();
    trace("command", { name, us: Math.round((performance.now() - started) * 1000), ok: true }, send);
    return result;
  } catch (error) {
    trace("command", { name, us: Math.round((performance.now() - started) * 1000), ok: false,
      error: String(error?.message ?? error) }, send);
    throw error;
  }
}
