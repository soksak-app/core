// 터미널 플러그인의 진단 항목. diagnostics.json 이 선언하며 진단 빌드에만 스테이징된다.
//
// terminal.compose.update 는 OS 입력기가 만드는 preedit 를 주입한다. terminal.ime.trace 는
// 명시적으로 시작한 동안 네이티브 입력 callback 과 순서대로 보낸 터미널 입력 작업을 기록한다.
// 기록이 용량에 이르면 이벤트를 버리지 않고 기록을 멈추며 오류를 보고한다.

const IME_TRACE_CAPACITY = 256;

/**
 * 터미널 구현이 넘긴 내부 연산으로 진단 항목을 등록한다.
 *
 *   expose         표면의 공개 항목 등록 함수
 *   updateCompose  네이티브 compose callback 과 같은 경로로 preedit 를 바꾼다
 *   onInput        입력 기록 함수를 등록한다
 *   reportError    세션 오류를 보고한다
 */
export async function attach({ expose, updateCompose, onInput, reportError }) {
  let trace = { enabled: false, overflow: false, entries: [] };
  const watchers = new Set();
  const changed = () => {
    for (const fn of watchers) fn(trace);
  };
  onInput((entry) => {
    if (!trace.enabled) return;
    if (trace.entries.length === IME_TRACE_CAPACITY) {
      trace = { ...trace, enabled: false, overflow: true };
      changed();
      reportError("IME diagnostic trace capacity exceeded");
      return;
    }
    trace = { ...trace, entries: [...trace.entries, { sequence: trace.entries.length, ...entry }] };
    changed();
  });
  await Promise.all([
    expose.status("terminal.ime.trace", () => trace, (fn) => {
      watchers.add(fn);
      return () => watchers.delete(fn);
    }),
    expose.command("terminal.compose.update", updateCompose),
    expose.command("terminal.ime.trace", async ({ action }) => {
      if (action === "start") {
        trace = { enabled: true, overflow: false, entries: [] };
      } else if (action === "stop") {
        trace = { ...trace, enabled: false };
      } else {
        throw new Error("terminal.ime.trace action must be start or stop");
      }
      changed();
      return trace;
    }),
  ]);
}
