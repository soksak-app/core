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

/**
 * 고정 사이드바 place 가 보일 세트를 고르는 연결을 반환한다. 초점 플러그인의 오버라이드가 적용되면 그 window-* 연결,
 * 아니면 일반 연결이며, 세트가 없으면 null 이다. 알 수 없는 place 는 예외다.
 */
export function standingLink(place, descriptors) {
  const descriptor = descriptors.find(item => item.id === place);
  if (!descriptor) throw new Error(`unknown window sidebar ${place}`);
  if (descriptor.set === null) return null;
  return descriptor.plugin === null ? { place: descriptor.side, plugin: null } : { place: `window-${descriptor.side}`, plugin: descriptor.plugin };
}

/** 레일로 초점 카드와 묶을 고정 사이드바. 플러그인 오버라이드가 적용되었고 판에 있는 사이드바만 묶는다. */
export function railSidebars(descriptors, present) {
  return descriptors.filter(item => item.plugin !== null && present(item.id)).map(item => item.id);
}

/** 판의 고정 사이드바 카드에 그려진 폭을 기록 records 에 옮긴다. */
export function keepWindowSidebarWidths(cards, records) {
  for (const card of cards.filter(card => windowSidebar(card.id))) {
    if (card.width !== undefined) records[card.id].width = card.width;
  }
}

/**
 * 고정 사이드바 열을 선택에 맞춘다. shown(side) 가 거짓인 쪽의 열은 dismiss 로 없애고, 보일 열이 없으면 그 쪽
 * 가장자리에 저장 폭으로 넣는다. 순서가 달라진 경우에만 열을 옮기며, 초점이나 오버라이드 변경은 열을 옮기지 않는다.
 */
export function arrangeWindowSidebars(grid, descriptors, records, initialWidth, shown, dismiss) {
  reconcileWindowSidebars(records, [...descriptors, ...grid.cards.filter(card => windowSidebar(card.id)).map(card => ({ id: card.id, ...windowSidebar(card.id) }))], initialWidth);
  keepWindowSidebarWidths(grid.cards, records);
  for (const card of [...grid.cards].filter(card => windowSidebar(card.id))) {
    if (!descriptors.some(item => item.id === card.id && shown(item.side))) dismiss(card.id);
  }
  for (const side of ["left", "right"]) {
    const desired = descriptors.filter(item => item.side === side && shown(side));
    for (const item of desired) {
      if (!grid.card(item.id)) {
        const line = side === "left" ? 0 : grid.lines("x").length - 1;
        if (!grid.canInsertAt("x", line)) throw new Error(`cannot place window sidebar ${item.id}`);
        grid.insertAt("x", line, { id: item.id, data: null, size: records[item.id].width });
        grid.setFixed(item.id, true);
      }
    }
    const actual = grid.cards.filter(card => windowSidebar(card.id)?.side === side).sort((a,b) => a.c0-b.c0).map(card => card.id);
    const expected = (side === "left" ? desired : [...desired].reverse()).map(item => item.id);
    if (JSON.stringify(actual) === JSON.stringify(expected)) continue;
    for (const item of [...desired].reverse()) {
      const card = grid.card(item.id);
      if ((side === "left" && card.c0 !== 0) || (side === "right" && card.c1 !== grid.lines("x").length - 1)) {
        if (!grid.moveTo(item.id, "x", side === "left" ? 0 : grid.lines("x").length - 1)) throw new Error(`cannot order window sidebar ${item.id}`);
      }
    }
  }
}

/**
 * 레일 윤곽의 바깥 여백과 모서리 반지름. 선은 경로를 중심으로 그려지므로 경로를 반 통로에서 선 굵기의 절반만큼 안쪽에
 * 둔다. 그러면 선이 반 통로 안쪽을 채우고 바깥 가장자리가 반 통로에 놓여, 1배율 화면에서도 선이 두 픽셀에 나뉘어
 * 흐려지지 않는다.
 */
export function railOutlineOptions(gap, radius, borderWidth) {
  const pad = gap / 2 - borderWidth / 2;
  return { pad, radius: radius === 0 ? 0 : radius + pad };
}
