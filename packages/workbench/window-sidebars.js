// 창 사이드바의 식별, 저장 소유자와 선언 순서를 관리한다. 포커스를 입력으로 받지 않는다.
export function windowSidebar(id) {
  if (id === "left" || id === "right") return { side: id, plugin: null };
  const match = /^window:([a-z][a-z0-9-]*):(left|right)$/.exec(id);
  return match ? { plugin: match[1], side: match[2] } : null;
}

export function windowSidebarCards(units, links) {
  const out = [];
  for (const side of ["left", "right"]) {
    const general = links.find(link => link.place === side && link.plugin === null);
    if (general) out.push({ id: side, side, plugin: null, set: general.set });
    for (const unit of units) {
      const link = links.find(link => link.place === `window-${side}` && link.plugin === unit.id);
      if (link) out.push({ id: `window:${unit.id}:${side}`, side, plugin: unit.id, set: link.set });
    }
  }
  return out;
}

const tabs = cards => cards.flatMap(card => (card.data?.tabs ?? []).map(tab => ({ card: card.id, tab })));

export function restoreWindowSidebars(saved, units, cards) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("invalid window sidebar records");
  const all = tabs(cards);
  const out = {};
  for (const [id, record] of Object.entries(saved)) {
    const descriptor = windowSidebar(id);
    if (!descriptor || (descriptor.plugin !== null && !units.some(unit => unit.id === descriptor.plugin))) throw new Error(`unknown window sidebar ${id}`);
    if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).some(key => !["width", "owner"].includes(key)) ||
        !Number.isFinite(record.width) || record.width <= 0 || !(record.owner === null || typeof record.owner === "string")) throw new Error(`invalid window sidebar ${id}`);
    const owner = all.find(item => item.tab.id === record.owner);
    if (record.owner !== null && (!owner || owner.tab.plugin !== descriptor.plugin)) throw new Error(`invalid window sidebar owner ${id}`);
    out[id] = { ...record };
  }
  return out;
}

export function reconcileWindowSidebars(records, descriptors, cards, initialWidth) {
  const all = tabs(cards);
  // 구조적 조작으로 소유 탭이 사라졌을 때만 저장 순서의 다음 탭을 선택한다.
  for (const [id, record] of Object.entries(records)) {
    const { plugin } = windowSidebar(id);
    if (record.owner !== null && !all.some(item => item.tab.id === record.owner)) record.owner = all.find(item => item.tab.plugin === plugin)?.tab.id ?? null;
  }
  for (const descriptor of descriptors) {
    const record = records[descriptor.id] ??= { width: initialWidth, owner: null };
    if (record.owner === null && descriptor.plugin !== null) record.owner = all.find(item => item.tab.plugin === descriptor.plugin)?.tab.id ?? null;
  }
}

export function windowOwner(records, id, cards) {
  const owner = records[id]?.owner;
  const found = owner === null || owner === undefined ? null : tabs(cards).find(item => item.tab.id === owner);
  return { card: found?.card ?? null, surface: found?.tab.id ?? null,
    available: Boolean(found && cards.find(card => card.id === found.card).data.activeId === found.tab.id) };
}
