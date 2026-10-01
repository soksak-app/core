// 고정 좌우 사이드바의 내용 오버라이드와 변별 폭을 관리한다.
export function windowSidebar(id) {
  return id === "left" || id === "right" ? { side: id, plugin: null } : null;
}

export function windowSidebarCards(units, links, focusedPlugin = null) {
  if (focusedPlugin !== null && !units.some(unit => unit.id === focusedPlugin)) throw new Error(`unknown window sidebar plugin ${focusedPlugin}`);
  const out = [];
  for (const side of ["left", "right"]) {
    const choices = links.filter(link => link.place === side || link.place === `window-${side}`);
    if (!choices.length) continue;
    const override = focusedPlugin === null ? undefined : choices.find(link => link.place === `window-${side}` && link.plugin === focusedPlugin);
    const general = choices.find(link => link.place === side && link.plugin === null);
    // 기본값: 초점 플러그인의 오버라이드가 없으면 일반 선택을 쓴다(docs/spec/external-sidebars.md).
    const chosen = override ?? general;
    // 기본값: 선택이 없으면 그 고정 사이드바의 내용 세트는 없다.
    out.push({ id: side, side, plugin: override ? focusedPlugin : null, set: chosen?.set ?? null });
  }
  return out;
}

export function restoreWindowSidebars(saved) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("invalid window sidebar records");
  const out = {};
  for (const [id, record] of Object.entries(saved)) {
    if (!windowSidebar(id)) throw new Error(`unknown window sidebar ${id}`);
    if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).some(key => key !== "width") ||
        !Number.isFinite(record.width) || record.width <= 0) throw new Error(`invalid window sidebar ${id}`);
    out[id] = { width: record.width };
  }
  return out;
}

export function reconcileWindowSidebars(records, descriptors, initialWidth) {
  if (!Number.isFinite(initialWidth) || initialWidth <= 0) throw new Error("invalid initial window sidebar width");
  for (const descriptor of descriptors) {
    if (!windowSidebar(descriptor.id)) throw new Error(`unknown window sidebar ${descriptor.id}`);
    // 기본값: 너비 기록이 없는 고정 사이드바는 처음 너비로 시작한다.
    records[descriptor.id] ??= { width: initialWidth };
  }
}
