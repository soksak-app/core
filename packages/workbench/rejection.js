// 처리되지 않은 거부를 애플리케이션 로그 한 줄로 바꾼다.

/**
 * 거부 사유의 로그 줄. WebKit 의 Error.stack 은 호출 위치만 담고 메시지를 담지 않으므로, Error 는 메시지와 stack 을
 * 함께 적는다. Error 가 아닌 값은 그 값을 적는다.
 */
export function rejectionLine(reason) {
  if (!(reason instanceof Error)) return `rejected: ${String(reason)}`;
  return reason.stack ? `rejected: ${reason.message}\n${reason.stack}` : `rejected: ${reason.message}`;
}
