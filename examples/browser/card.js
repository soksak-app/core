// [data-native-modal] 카드가 어느 문서에서 그려지든 갖는 거동.
//
// 카드는 자기를 가진 문서에도, 그 사본을 그리는 네이티브 뷰에도 있다. 여기 있는
// 것은 그 둘 모두에서 같아야 하는 것들이다.
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

/**
 * 끌고 있는 동안 슬라이더 옆의 수를 따라가게 한다.
 *
 * 값이 바뀌었다고 알리는 것은 손을 뗄 때(change)다. 그 사이에도 수는 손을 따라야
 * 하는데, 매 input 마다 알리면 카드가 통째로 다시 그려져 끌던 손잡이가 사라진다.
 * 그래서 이 표시는 알리지 않고 여기서만 고친다.
 */
export function showValue(root) {
  root.addEventListener("input", (e) => {
    const el = e.target.closest("input[type=range][data-set]");
    if (!el) return;
    const out = el.parentElement.querySelector("output");
    if (out) out.textContent = out.textContent.replace(/^-?[\d.]+/, el.value);
  });
}
