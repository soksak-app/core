// 페이지의 성능 트레이스 생산자. 스위치와 중계 요청은 응답 순서로 처리한다.
import { host as bridge } from "@soksak/runtime";

function reportRelayError(error) {
  console.error("performance trace relay failed:", error);
  if (typeof ErrorEvent === "function") {
    globalThis.dispatchEvent?.(new ErrorEvent("error", { message: error.message, error }));
  }
}

export function createTracer(call, report = reportRelayError) {
  let enabled = false;
  let switching = false;
  let revision = 0;
  let pending = Promise.resolve();
  const enqueue = (work) => {
    // 앞선 요청의 실패는 그 요청의 호출자나 중계 오류 보고기가 이미 전달받는다.
    // 이후 명시적 요청은 별도의 결과를 갖고 순서대로 실행한다.
    const result = pending.then(work, work);
    pending = result;
    return result;
  };
  const setEnabled = (on) => {
    if (typeof on !== "boolean") throw new TypeError("trace enabled must be a boolean");
    if (!call || (!switching && enabled === on)) return Promise.resolve();
    const mine = ++revision;
    enabled = false;
    switching = true;
    return enqueue(async () => {
      try {
        await call({ action: on ? "on" : "off" });
        if (mine === revision) enabled = on;
      } finally {
        if (mine === revision) switching = false;
      }
    });
  };
  const trace = (event, fields = {}) => {
    if (!enabled) return Promise.resolve();
    const line = { ts: new Date().toISOString(), event, ...fields };
    const memory = globalThis.performance?.memory;
    if (memory) line.jsHeapMB = Math.round(memory.usedJSHeapSize / 1048576);
    const result = enqueue(() => call({ action: "line", line }));
    result.catch(report);
    return result;
  };
  const timed = async (name, answer) => {
    if (!enabled) return answer();
    const started = performance.now();
    try {
      const result = await answer();
      trace("command", { name, us: Math.round((performance.now() - started) * 1000), ok: true });
      return result;
    } catch (error) {
      trace("command", { name, us: Math.round((performance.now() - started) * 1000), ok: false,
        error: String(error?.message ?? error) });
      throw error;
    }
  };
  return { setEnabled, trace, timed };
}

const tracer = createTracer(bridge ? (request) => bridge.call("performance", request) : null);
export const setTraceEnabled = tracer.setEnabled;
export const trace = tracer.trace;
export const timed = tracer.timed;
