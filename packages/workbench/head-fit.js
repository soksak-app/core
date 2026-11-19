// The fold stage of a card head (docs/spec/example-model.md#card-tabs). The shared layout cases of docs/spec/cases/layout/head.json state
// it, and the Go layout model of packages/workbench-mygo meets the same cases, so both workbenches fold a head at the same widths.

/**
 * The stage of the tabs and of the tools of a card head, from its measured widths.
 *
 * The head folds in this order: the other tabs, the tools into the ⋯ menu beside the kept tools down to the minimum width of the title,
 * the kept tools into the menu down to the grab width of the title, then the title. The first stage whose condition holds is used. head
 * gives the width of the head, its paddingLeft and paddingRight, the width of its leading button (lead), the gap between its elements,
 * the width of its tools (toolsWidth), of its ⋯ button (moreWidth) and of the tools that the menu stage keeps beside ⋯ with their gaps,
 * the fullscreen toggle and the leader mark (keptWidth), the widths of its tabs (tabWidths) and the gap between them (tabGap), and the
 * chrome metrics tab-peek-w (peek: the spare width beside the widest tab that keeps every tab), tab-min-w (minTab: the width under which
 * the kept tools fold) and tab-grab-w (grab: the width under which the active tab drops). Each condition takes the widest tab in place of
 * the active tab, so the stage is the same whichever tab is active (docs/spec/example-model.md#card-tabs). Returns fit (strip: every tab,
 * one: the active tab, ham: no tab) and tools (bar, menu: ⋯ with the kept tools, all: ⋯ alone).
 */
export function fitHead(head) {
  const inner = head.width - head.paddingLeft - head.paddingRight - (head.lead + head.gap);
  const whole = head.tabWidths.reduce((n, w) => n + w, 0) + Math.max(0, head.tabWidths.length - 1) * head.tabGap;
  const withTools = inner - head.toolsWidth - head.gap;
  const withKept = inner - head.moreWidth - head.keptWidth - head.gap;
  const withMore = inner - head.moreWidth - head.gap;
  const widest = Math.max(0, ...head.tabWidths);
  if (withTools >= Math.min(whole, widest + head.peek)) return { fit: "strip", tools: "bar" };
  if (withTools >= widest) return { fit: "one", tools: "bar" };
  if (withKept >= Math.min(widest, head.minTab)) return { fit: "one", tools: "menu" };
  if (withMore >= Math.min(widest, head.grab)) return { fit: "one", tools: "all" };
  return { fit: "ham", tools: "all" };
}
