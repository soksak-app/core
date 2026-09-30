// 그려진 슬롯에서 이전 사이드바를 빼고 요청한 사이드바의 여백을 계산한다.
const sides = ["left", "right", "top", "bottom"];
export function targetCardInsets(card, slot, bands) {
  for (const side of sides) {
    if (!Number.isFinite(bands[side]) || bands[side] < 0) throw new Error(`invalid sidebar band ${side}`);
  }
  const box = card.getBoundingClientRect();
  const inner = slot.getBoundingClientRect();
  if (inner.width <= 0 || inner.height <= 0) return null;
  const drawn = Object.fromEntries(sides.map(side => {
    const region = card.querySelector(`:scope > .card-sidebar[data-side-of="${side}"]`);
    // 없는 사이드바는 영역을 차지하지 않는다.
    const rect = region?.getBoundingClientRect();
    return [side, rect ? (side === "left" || side === "right" ? rect.width : rect.height) : 0];
  }));
  return {
    left: inner.left - box.left - drawn.left + bands.left,
    top: inner.top - box.top - drawn.top + bands.top,
    width: box.width - inner.width - drawn.left - drawn.right + bands.left + bands.right,
    height: box.height - inner.height - drawn.top - drawn.bottom + bands.top + bands.bottom,
  };
}
