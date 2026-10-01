// 저장된 스페이스 배치를 검사한다. 배치를 여는 것과 라이브러리 미리보기가 같은 검사를 써서, 열 수 없는 배치를
// 미리보기가 걸러서 그리지 않는다(docs/spec/projects.md).
import { pluginUnits } from "./environment.js";
import { windowSidebar } from "./window-sidebars.js";

/** 저장 배치 kept 가 현재 환경에서 열 수 없으면 그 이유로 예외를 던진다. */
export function checkStoredLayout(kept) {
  if (Object.hasOwn(kept, "sidebars") && (!kept.sidebars || typeof kept.sidebars !== "object" || Array.isArray(kept.sidebars)))
    throw new Error("invalid stored sidebar choices");
  if (Object.hasOwn(kept, "railWidth") || Object.hasOwn(kept, "edgeWidth")) throw new Error("obsolete window sidebar state");
  const units = pluginUnits();
  for (const card of kept.state.cards) {
    if (card.id.startsWith("window:")) throw new Error(`obsolete stored window sidebar ${card.id}`);
    if (card.id.startsWith("rail-")) throw new Error(`obsolete stored rail card ${card.id}`);
    const descriptor = windowSidebar(card.id);
    if (descriptor) {
      if (card.data !== null && card.data !== undefined) throw new Error(`invalid stored window sidebar data ${card.id}`);
    } else {
      const tabs = card.data?.tabs;
      if (!Array.isArray(tabs) || !tabs.length) throw new Error(`invalid stored content card ${card.id}`);
      for (const tab of tabs) if (!units.some(unit => unit.id === tab.plugin && unit.surface)) throw new Error(`unknown stored tab plugin ${tab.plugin}`);
      if (!tabs.some(tab => tab.id === card.data.activeId)) throw new Error(`invalid stored active tab ${card.id}`);
    }
  }
  // 기본값: 저장 레이아웃의 sidebars 는 선택 필드다.
  for (const id of Object.keys(kept.sidebars ?? {})) if (id.startsWith("rail-") || id.startsWith("window:")) throw new Error(`obsolete stored sidebar ${id}`);
}
