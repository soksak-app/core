// Passes the pointer input of the card sidebar boundary line to declared commands.
const DRAG_THRESHOLD = 3;
export function bindSidebarGrip(el, handle, side, defaults, run) {
  // Distinguishes a drag from a press by the movement of the boundary line.
  let dragged = false;
  handle.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    dragged = false;
    const startX = event.clientX, startY = event.clientY;
    const rect = handle.parentElement.getBoundingClientRect();
    const initialSize = side === "left" || side === "right" ? rect.width : rect.height;
    if (!Number.isFinite(initialSize) || initialSize < 0) throw new Error("invalid sidebar drag extent");
    // A collapsed side opens when the pointer reaches the minimum size. If it opened at the minimum size before that, the boundary would run ahead of the pointer.
    const folded = el.dataset[`sidebar${side[0].toUpperCase()}${side.slice(1)}`] === "folded";
    const move = (e) => {
      if (!dragged && Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
      dragged = true;
      const clamp = (raw) => Math.min(defaults.max, Math.max(defaults.min, raw));
      // Adds only the actual movement, excluding the offset of the press position and the area on the opposite side.
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
