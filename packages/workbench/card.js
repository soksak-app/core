// [data-native-modal] 카드의 입력 처리. 메인 문서와 오버레이 뷰가 함께 사용한다.
//
// 카드는 메인 문서에 하나, 네이티브 뷰에 사본 하나가 있다. 두 문서가 같은 입력을
// 처리해야 하므로 여기에 둔다.

/**
 * root 안의 컨트롤이 답한 (key, value) 를 send 로 전달한다.
 *
 * 누름은 value 가 비어 있고, 값 변경은 그 값을 담는다. 컨트롤마다 리스너를 등록하지
 * 않는다. 네이티브 뷰는 이 요소의 사본을 렌더링하므로 거기 등록한 리스너가 동작하지
 * 않는다.
 */
export function onAnswer(root, send) {
  root.addEventListener("click", (e) => {
    const hit = e.target.closest("[data-key]");
    if (hit) send(hit.dataset.key, "");
  });
  root.addEventListener("change", (e) => {
    const el = e.target.closest("[data-set]");
    if (el) send(el.dataset.set, el.type === "checkbox" ? String(el.checked) : el.value);
  });
  // 메뉴는 Escape 로 취소한다. dialog 는 자기 닫기 버튼으로만 닫는다.
  root.addEventListener("keydown", (e) => {
    const menu = '[data-native-modal="menu"]';
    if (e.key === "Escape" && (root.matches?.(menu) || root.querySelector(menu))) send("", "");
  });
}

/**
 * root 안의 [data-grip] 을 드래그하면 moved(dx, dy) 를 호출한다.
 *
 * 이동 거리를 화면 좌표 차이로 계산한다. 오버레이 뷰는 드래그를 따라 이동하므로 뷰
 * 내부 좌표는 매 프레임 기준이 바뀌고, movementX 는 OS 델타가 없는 이벤트에서 0 이다.
 * 위치 결정은 카드를 소유한 문서가 담당한다.
 *
 * [data-grip] 내부의 button 은 제외한다. 닫기 버튼 클릭이 드래그가 되면 안 된다.
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
 * range 입력을 드래그하는 동안 옆의 output 텍스트를 갱신한다.
 *
 * 설정 변경 보고는 change 에서만 한다. input 마다 보고하면 카드를 다시 그리면서
 * 드래그 중인 요소가 교체된다. 이 표시는 보고하지 않고 여기서만 갱신한다.
 */
export function showValue(root) {
  root.addEventListener("input", (e) => {
    const el = e.target.closest("input[type=range][data-set]");
    if (!el) return;
    const out = el.parentElement.querySelector("output");
    if (out) out.textContent = out.textContent.replace(/^-?[\d.]+/, el.value);
  });
}
