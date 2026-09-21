/**
 * 호출 기록기. 호출과 그 답을 한 줄씩 애플리케이션 로그에 보낸다.
 *
 * 애플리케이션은 페이지의 호출을 여러 스레드에서 동시에 처리할 수 있다. 줄을 받는 즉시
 * 보내면 먼저 보낸 줄이 나중에 도착할 수 있으므로, 앞 줄의 전송이 끝난 뒤 다음 줄을 보낸다.
 *
 * send(line) 은 줄 하나를 애플리케이션에 보내고 그 완료를 promise 로 반환한다.
 */
export function createTranscript(send, reportError = (error) => console.error("transcript send failed:", error?.message ?? error)) {
  let recording = false;
  let sent = Promise.resolve();

  /** 답이 없는 호출을 한 가지로 적는다. 프레임워크마다 빈 답의 모양이 다르다. */
  const say = (value) => {
    const empty = value == null ||
      (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
    return empty ? "null" : JSON.stringify(value);
  };

  return {
    /** 기록을 켜거나 끈다. */
    set(on) {
      recording = on === true;
    },

    /**
     * 호출 name 의 답 answered 가 나오면 줄을 보낸다. 줄은 답이 나온 순서대로 보낸다.
     * 실패한 호출은 부르는 쪽이 보고하므로 적지 않는다.
     */
    record(name, payload, answered) {
      if (!recording) return;
      Promise.resolve(answered).then((answer) => {
        const line = `host ${name} ${say(payload)} -> ${say(answer)}`;
        sent = sent.then(() => send(line)).then(undefined, reportError);
      }, (error) => reportError(new Error(`host ${name} failed before transcript: ${error?.message ?? error}`)));
    },
  };
}
