/**
 * 모달 문서가 받은 내용과 위치를 호스트가 바꾼 순서대로 적용한다.
 *
 * 호스트는 모달의 내용이나 위치를 바꿀 때마다 revision 을 올린다. 문서는 처음 내용을 호출의
 * 응답으로, 이후 변경을 이벤트로 받는다. 둘은 다른 경로로 도착하므로 응답이 더 늦게 만든
 * 이벤트보다 나중에 올 수 있다. 이미 적용한 것보다 오래된 내용과 위치는 버린다.
 *
 * render(content, card) 는 내용을 그린다. card 는 그 내용의 위치가 적용한 위치보다 새로울
 * 때만 있고, 아니면 null 이다. place(card) 는 위치만 바꾼다.
 */
export function modalOrder(render, place) {
  let content = 0;
  let position = 0;
  return {
    content({ revision, content: value }) {
      if (revision <= content) return;
      content = revision;
      const card = revision > position ? value.card : null;
      if (card) position = revision;
      render(value, card);
    },
    position({ revision, card }) {
      if (revision <= position) return;
      position = revision;
      place(card);
    },
  };
}
