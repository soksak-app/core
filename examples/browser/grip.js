// 잡이를 끌어 무언가를 옮기는 제스처.
//
// 카드를 가진 문서와 그 사본을 그리는 문서가 같은 제스처를 쓴다. 어디까지
// 옮겼는지는 여기서 정하지 않는다 — 움직인 만큼만 알리고, 자리를 정하는 것은
// 카드를 소유한 쪽 하나다.
//
// 알리는 것이 좌표가 아니라 변화량인 이유: 사본을 그리는 뷰는 이 제스처를 따라
// 함께 움직이므로, 그 안에서 잰 좌표는 매 프레임 기준이 달라진다. 움직인 양은
// 기준이 없어서 달라지지 않는다.
//
// 그 양은 화면 좌표의 차이로 잰다. movementX 는 OS 가 실어 준 이동량이라 그것을
// 싣지 않는 이벤트에서는 0 이고, 화면 좌표는 무엇이 움직였든 늘 같은 원점을
// 갖는다.

/**
 * root 안의 [data-grip] 을 누른 채 끌면 moved(dx, dy) 를 부른다.
 *
 * 잡이 안의 단추는 잡이가 아니다 — 닫기를 누르려던 것이 끌기가 되면 안 된다.
 */
export function onGripDrag(root, moved) {
  root.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (!e.target.closest("[data-grip]") || e.target.closest("button")) return;
    e.preventDefault();
    let x = e.screenX;
    let y = e.screenY;
    const move = (ev) => {
      moved(ev.screenX - x, ev.screenY - y);
      x = ev.screenX;
      y = ev.screenY;
    };
    const up = () => {
      removeEventListener("mousemove", move);
      removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
  });
}
