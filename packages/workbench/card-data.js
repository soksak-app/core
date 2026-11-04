// The values of a card that the layout reads: the order of its tabs, its active tab, its text size and the tab name whose width the head
// measures. The shared layout cases of docs/spec/cases/layout/tabs.json state them, and the Go layout model of packages/workbench-mygo meets
// the same cases, so both workbenches order and select tabs alike.

// default: the fixed left and right sidebar cards have null data, so they have no surface tab.
export const tabsOf = (card) => card?.data?.tabs ?? [];
export const activeTab = (card) => tabsOf(card).find((t) => t.id === card.data.activeId);
// default: a card that was never resized shows its text at the factor 1.
export const cardTextSize = (card) => card?.data?.textSize ?? 1;

/** Takes a tab out of the card. The others keep their order, and the active tab stays until settleActiveTab. */
export function removeTab(card, tabId) {
  card.data.tabs = tabsOf(card).filter((t) => t.id !== tabId);
}

/** Puts a tab at the end of the card and makes it the active tab. */
export function appendTab(card, tab) {
  card.data.tabs.push(tab);
  card.data.activeId = tab.id;
}

/** Selects the first tab when the active tab has left the card. */
export function settleActiveTab(card) {
  if (tabsOf(card).some((t) => t.id === card.data?.activeId)) return;
  // default: a card with no tabs left has no active tab (null).
  if (card.data) card.data.activeId = tabsOf(card)[0]?.id ?? null;
}

/** The name on a tab: the title that its surface reported, or the title of its layout entry, with a dot before a modified tab. */
export function tabName(tab, reported, modified) {
  // default: a tab whose surface reported no title shows the title of its layout entry.
  return `${modified ? "● " : ""}${reported ?? tab.title}`;
}
