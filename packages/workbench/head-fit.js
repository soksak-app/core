// The fold stage of a card head (docs/spec/example-model.md#card-tabs). The shared layout cases of docs/spec/cases/layout/head.json state
// it, and the Go layout model of packages/workbench-mygo meets the same cases, so both workbenches fold a head at the same widths.

/**
 * The stage of the tabs and of the tools of a card head, from its measured widths.
 *
 * The head folds in this order: the other tabs, the tools (into the ⋯ menu) down to the minimum width of the title, then the title. The
 * first stage whose condition holds is used. head gives the width of the head, its paddingLeft and paddingRight, the width of its leading
 * button (lead), the gap between its elements, the width of its tools (toolsWidth) and of its ⋯ button (moreWidth), the widths of its tabs
 * (tabWidths) and the gap between them (tabGap), the width of the active tab (activeWidth, 0 without one), and the chrome metrics
 * tab-peek-w (peek: the spare width beside the active tab that keeps every tab) and tab-min-w (minTab: the width under which the active
 * tab drops). Returns fit (strip: every tab, one: the active tab, ham: no tab) and tools (bar or menu).
 */
export function fitHead(head) {
  const inner = head.width - head.paddingLeft - head.paddingRight - (head.lead + head.gap);
  const whole = head.tabWidths.reduce((n, w) => n + w, 0) + Math.max(0, head.tabWidths.length - 1) * head.tabGap;
  const withTools = inner - head.toolsWidth - head.gap;
  const withMenu = inner - head.moreWidth - head.gap;
  if (withTools >= Math.min(whole, head.activeWidth + head.peek)) return { fit: "strip", tools: "bar" };
  if (withTools >= head.activeWidth) return { fit: "one", tools: "bar" };
  if (withMenu >= Math.min(head.activeWidth, head.minTab)) return { fit: "one", tools: "menu" };
  return { fit: "ham", tools: "menu" };
}
