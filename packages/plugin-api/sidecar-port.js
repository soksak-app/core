// 페이지의 사이드카 포트. 런타임의 포트는 호출마다 별도 요청으로 호스트에 전달하므로 두 전송이
// 겹치면 도착 순서가 바뀔 수 있다. 사이드카는 받은 순서대로 처리하므로(예: 실행 뒤의 중단) 앞선
// 전송이 끝난 뒤 다음 전송을 보낸다.

/**
 * port 는 런타임의 page.sidecar(name) 이다. 반환한 send 는 호출한 순서대로 전달되고, 각 전송의
 * 결과(실패 포함)를 호출자에게 돌려준다. 실패한 전송은 다음 전송을 막지 않는다.
 */
export function orderedSidecar(port) {
  let chain = Promise.resolve();
  return {
    send(surface, body) {
      const sent = chain.then(() => port.send(surface, body));
      // 내부 체인에서만 에러를 기록한다. 호출자는 sent를 받으므로 실패 시 rejection이 전달된다.
      chain = sent.catch((error) => {
        console.error(`sidecar send failed: ${error?.message ?? error}`);
      });
      return sent;
    },
    on: (surface, fn) => port.on(surface, fn),
  };
}
