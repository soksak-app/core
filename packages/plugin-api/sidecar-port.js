// 페이지의 사이드카 포트. 런타임의 포트는 호출마다 별도 요청으로 호스트에 전달하므로 두 전송이
// 겹치면 도착 순서가 바뀔 수 있다. 사이드카는 받은 순서대로 처리하므로(예: 실행 뒤의 중단) 앞선
// 전송이 끝난 뒤 다음 전송을 보낸다.

/**
 * port 는 런타임의 page.sidecar(name) 이다. 반환한 send 는 호출한 순서대로 전달되고, 각 전송의
 * 결과(실패 포함)를 호출자에게 돌려준다. 실패한 전송은 다음 전송을 막지 않으며, 그 오류를 failed 에 알린다.
 */
export function orderedSidecar(port, failed) {
  // 처리기가 없으면 실패한 전송이 체인을 거부된 채로 남겨 이후 전송을 모두 막으므로 경계에서 거부한다.
  if (typeof failed !== "function") throw new TypeError("orderedSidecar requires a failure handler");
  let chain = Promise.resolve();
  return {
    send(surface, body) {
      const sent = chain.then(() => port.send(surface, body));
      // 내부 체인에서만 오류를 알린다. 호출자는 sent를 받으므로 실패 시 rejection이 전달된다.
      chain = sent.catch(failed);
      return sent;
    },
    on: (surface, fn) => port.on(surface, fn),
    onFailure: (surface, fn) => port.onFailure(surface, fn),
  };
}
