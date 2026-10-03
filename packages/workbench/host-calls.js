// 페이지가 보낸 호스트 호출의 진행. 페이지가 스스로 다시 읽기 전에 보낸 호출이 모두 답을 받게 한다
// (docs/spec/native-host.md#page-reload). 두 애플리케이션의 런타임이 각자의 호출을 이것으로 감싼다.

/**
 * call 을 감싸 진행 중인 호출을 센다. settle() 은 그때까지 보낸 호출이 모두 답을 받으면 끝나고, 그 뒤의 호출은
 * 보내지 않는다. 보내지 않은 호출은 다시 읽기가 멈춘 호출처럼 문서와 함께 끝나므로 끝나지 않는 약속을 돌려준다.
 */
export function settlingCalls(call) {
  let pending = 0;
  let settled = null;
  let resolve = null;
  const answered = () => {
    pending -= 1;
    if (pending === 0 && resolve) resolve();
  };
  return {
    call(...args) {
      if (settled) return new Promise(() => {});
      pending += 1;
      const result = Promise.resolve().then(() => call(...args));
      result.then(answered, answered);
      return result;
    },
    settle() {
      if (!settled) {
        settled = new Promise((done) => { resolve = done; });
        if (pending === 0) resolve();
      }
      return settled;
    },
  };
}
