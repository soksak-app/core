// 카드 사이드바 경계선의 포인터 입력을 선언된 명령으로 전달한다.
const DRAG_THRESHOLD = 3;
export function bindSidebarGrip(el, handle, side, defaults, run) {
  // 경계선의 움직임으로 끌기와 누름을 구분한다.
  let dragged = false;
  handle.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    dragged = false;
    const startX = event.clientX, startY = event.clientY;
    const rect = handle.parentElement.getBoundingClientRect();
    const initialSize = side === "left" || side === "right" ? rect.width : rect.height;
    if (!Number.isFinite(initialSize) || initialSize < 0) throw new Error("invalid sidebar drag extent");
    // 접힌 면은 포인터가 최소 크기에 닿을 때 연다. 그 전에 최소 크기로 열면 경계가 포인터보다 앞선다.
    const folded = el.dataset[`sidebar${side[0].toUpperCase()}${side.slice(1)}`] === "folded";
    const move = (e) => {
      if (!dragged && Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
      dragged = true;
      const clamp = (raw) => Math.min(defaults.max, Math.max(defaults.min, raw));
      // 누른 위치의 오프셋과 반대편 영역을 제외하고 실제 이동량만 더한다.
      const delta = side === "left" ? e.clientX - startX
        : side === "right" ? startX - e.clientX
        : side === "top" ? e.clientY - startY
        : startY - e.clientY;
      if (!Number.isFinite(delta)) throw new Error("invalid sidebar pointer displacement");
      if (folded && initialSize + delta < defaults.min) return;
      const size = clamp(initialSize + delta);
      run("core.card.sidebar.size", { card: el.dataset.cardId, side, size });
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
  handle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (dragged) return;
    run("core.card.sidebar.toggle", { card: el.dataset.cardId, side });
  });
}
