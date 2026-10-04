// 늦은 표면 답 검사가 애플리케이션 로그의 줄을 판정한다(docs/spec/exposure.md#relay).
//
// 호스트는 표면을 제거할 때 그 표면에 보낸 요청을 1003 으로 끝내므로, 그 뒤에 도착한 표면의 답에는 답할 요청이 없다.
// 호스트는 그 답을 버리고 관측 줄을 쓰며 오류 줄은 쓰지 않는다.

/** 정규식에서 특별한 뜻을 가진 문자를 그대로 맞추도록 바꾼다. */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 표면 surface 의 늦은 답을 버린 호스트의 관측 줄. 두 호스트는 표면 id 를 따옴표로 감싸 쓴다. */
const observation = (surface) =>
  new RegExp(`^exposure reply \\d+ of removed surface ${literal(JSON.stringify(surface))} arrived after its request ended$`);

/** 붙잡은 답을 표면이 제거된 뒤에 보낸 페이지가 쓰는 줄(docs/spec/endpoint.md 의 diagnostics.surface.hold). */
export const heldRepliesSent = (surface, count) =>
  `held exposure replies of surface ${JSON.stringify(surface)} were sent after the surface closed (${count})`;

/** 로그 줄 중 surface 의 늦은 답 관측과 오류 줄. */
export function lateReplyFindings(lines, surface) {
  const pattern = observation(surface);
  return {
    observations: lines.filter((line) => pattern.test(line)),
    errors: lines.filter((line) => line.startsWith("error: ")),
  };
}
