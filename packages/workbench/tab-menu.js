// The items of the tab context menu (docs/spec/exposure.md#tab-memory). The plane draws them in the picker layer, and the chosen
// item runs its declared command.

// The reasons of a tab that can never be unloaded; such a tab has no keep item.
const NEVER = new Set(["undeclared", "background"]);

/**
 * The items of the context menu of a tab from the reasons that core.tab.memory reports for it: the keep item shows the mark
 * kept and runs core.tab.keep with the toggled value.
 */
export function tabMenuItems(tab, reasons) {
  if (reasons.some((reason) => NEVER.has(reason))) return [];
  const kept = reasons.includes("kept");
  return [{ key: "keep", expose: "core.tab.menu-keep", name: "메모리에 유지", mark: "", svg: "", active: kept,
    command: "core.tab.keep", params: { tab, keep: !kept } }];
}
