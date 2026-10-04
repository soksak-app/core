/**
 * 표면 exposure 답의 진단 붙잡기(docs/spec/endpoint.md 의 diagnostics.surface.hold).
 *
 * 붙잡은 표면이 보내는 답은 호스트가 그 표면을 제거했다고 알릴 때까지 보내지 않는다. 호스트는 표면을 제거하면서 그
 * 표면에 보낸 요청을 1003 으로 끝내므로, 그 뒤에 보낸 답은 요청이 끝난 뒤에 도착한 답이다. 창 검사는 이것으로 그
 * 답을 시간에 기대지 않고 만든다.
 *
 * log(line) 은 관측 줄 하나를 애플리케이션 로그에 보내고 그 완료를 promise 로 반환한다.
 */
export function createSurfaceReplyHold(log) {
  /* 붙잡은 표면마다 { sends, waiters }. sends 는 보내지 않은 답의 전송, waiters 는 held 의 대기다. */
  const holds = new Map();

  const required = (method, surface) => {
    if (typeof surface !== "string" || !surface) throw new Error(`${method} requires surface`);
  };

  return {
    /** surface 의 답을 붙잡기 시작한다. */
    hold(surface) {
      required("diagnostics.surface.hold", surface);
      if (holds.has(surface)) throw new Error(`exposure replies of surface "${surface}" are already held`);
      holds.set(surface, { sends: [], waiters: [] });
    },

    /** surface 가 답 하나를 붙잡으면 끝나는 promise. */
    held(surface) {
      required("diagnostics.surface.held", surface);
      const hold = holds.get(surface);
      if (!hold) throw new Error(`exposure replies of surface "${surface}" are not held`);
      if (hold.sends.length > 0) return Promise.resolve();
      return new Promise((resolve, reject) => hold.waiters.push({ resolve, reject }));
    },

    /** surface 의 답 하나를 보낸다. send() 는 답을 보내고 호스트의 응답을 promise 로 반환한다. */
    gate(surface, send) {
      const hold = holds.get(surface);
      if (!hold) return send();
      return new Promise((resolve, reject) => {
        hold.sends.push(() => send().then(resolve, reject));
        for (const waiter of hold.waiters.splice(0)) waiter.resolve();
      });
    },

    /**
     * 호스트가 surface 를 제거했다. 붙잡은 답을 붙잡은 순서로 보내고 붙잡기를 끝낸다. 호스트가 모든 답에 응답한
     * 뒤 관측 줄을 쓴다. 응답의 실패는 각 답을 보낸 쪽이 받는다.
     */
    closed(surface) {
      const hold = holds.get(surface);
      if (!hold) return Promise.resolve();
      holds.delete(surface);
      for (const waiter of hold.waiters.splice(0)) {
        waiter.reject(new Error(`surface "${surface}" closed before it held an exposure reply`));
      }
      const sent = hold.sends.map((send) => send());
      return Promise.allSettled(sent).then(() =>
        log(`held exposure replies of surface "${surface}" were sent after the surface closed (${sent.length})`));
    },
  };
}
