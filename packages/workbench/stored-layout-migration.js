// 이전 형식으로 저장한 공간 배치를 현재 형식으로 바꾼다(docs/spec/projects.md). 저장소를 읽을 때 한 번 쓴다.

/**
 * 이전 형식으로 저장한 배치를 현재 형식으로 바꾼다. 창 사이드바 폭, 카드의 패널과 inset 사이드바, 카드 id 로 저장한
 * 사이드바 선택을 각각 아래 함수가 바꾼다. 반환값은 { layout, changes } 이며, 바꿀 것이 없으면 layout 은 받은 값
 * 그대로이고 changes 는 비어 있다. 두 형식이 함께 있거나 이전 값이 맞지 않으면 예외를 던진다. 받은 값은 바꾸지 않는다.
 */
export function migrateStoredLayout(kept) {
  // 카드 목록이 없는 배치는 이전 형식이 아니라 잘못된 배치다. 바꾸지 않고 넘겨 checkStoredLayout 이 이유와 함께 거부한다.
  if (!Array.isArray(kept?.state?.cards)) return { layout: kept, changes: [] };
  const cards = migrateCards(kept.state.cards);
  const windows = migrateWindowSidebars(kept);
  const choices = migrateChoices(kept);
  const changes = [...windows.changes, ...cards.changes, ...choices.changes];
  if (!changes.length) return { layout: kept, changes };
  const layout = { ...windows.layout, state: { ...kept.state, cards: cards.cards } };
  if (choices.changes.length) layout.sidebars = choices.sidebars;
  return { layout, changes };
}

/**
 * 카드 id 로 저장한 사이드바 선택은 그 카드의 왼쪽 inset 사이드바 선택이었다. 지금 이름인 `<card>:left` 로 옮기고,
 * 그 이름의 선택이 이미 있으면 지금 선택이 우선한다. 창 사이드바 카드(데이터가 없는 카드)의 선택은 그대로다.
 */
function migrateChoices(kept) {
  if (!Object.hasOwn(kept, "sidebars")) return { sidebars: undefined, changes: [] };
  const content = new Set(kept.state.cards.filter((card) => card.data).map((card) => card.id));
  const changes = [];
  const sidebars = {};
  for (const [id, choice] of Object.entries(kept.sidebars)) {
    if (!content.has(id)) { sidebars[id] = choice; continue; }
    const left = `${id}:left`;
    if (Object.hasOwn(kept.sidebars, left)) changes.push(`sidebar choice ${id} was dropped because ${left} is stored`);
    else { sidebars[left] = choice; changes.push(`sidebar choice ${id} became ${left}`); }
  }
  return { sidebars, changes };
}

/**
 * 카드 데이터의 이전 패널 기록(panels)과 왼쪽 inset 사이드바(sidebar)를 카드 사이드바(sidebars)로 바꾼다. panels 의 각
 * 변은 같은 필드로 옮기고 지정이 없는(set 이 null) 변은 옮기지 않는다. inset 사이드바의 폭과 접힘은 왼쪽 사이드바의
 * size 와 collapsed 가 되며 세트는 지금도 plugin 연결이 정한다. 카드가 왼쪽을 명시 지정했으면 그 지정이 우선한다.
 */
function migrateCards(cards) {
  const changes = [];
  const migrated = cards.map((card) => {
    if (!card.data || (!Object.hasOwn(card.data, "panels") && !Object.hasOwn(card.data, "sidebar"))) return card;
    if (Object.hasOwn(card.data, "sidebars")) throw new Error(`card ${card.id} has both earlier and current sidebars`);
    const { panels, sidebar, ...data } = card.data;
    const sidebars = {};
    if (panels !== undefined) {
      for (const [side, entry] of Object.entries(panels)) {
        if (entry.set === null) continue;
        sidebars[side] = entry;
      }
      changes.push(`card ${card.id}: panels became sidebars`);
    }
    if (sidebar !== undefined) {
      if (Object.hasOwn(sidebars, "left")) {
        changes.push(`card ${card.id}: the inset sidebar was dropped because the card assigns its left sidebar`);
      } else {
        if (!Number.isFinite(sidebar.width) || sidebar.width <= 0) throw new Error(`card ${card.id} inset sidebar width is not a width`);
        sidebars.left = { size: sidebar.width, collapsed: sidebar.collapsed === true };
        changes.push(`card ${card.id}: the inset sidebar became the left sidebar`);
      }
    }
    return { ...card, data: { ...data, sidebars } };
  });
  return { cards: migrated, changes };
}

/** 이전 창 사이드바 폭(edgeWidth, railWidth)을 windowSidebars 로 바꾼다. */
function migrateWindowSidebars(kept) {
  const earlier = ["edgeWidth", "railWidth"].some((key) => Object.hasOwn(kept, key));
  if (!earlier) return { layout: kept, changes: [] };
  if (Object.hasOwn(kept, "windowSidebars")) throw new Error("stored layout has both edgeWidth and windowSidebars");
  const { edgeWidth, railWidth, ...rest } = kept;
  const changes = [];
  const windowSidebars = {};
  if (edgeWidth !== undefined) {
    for (const [id, width] of Object.entries(edgeWidth)) {
      if (!Number.isFinite(width) || width <= 0) throw new Error(`stored edgeWidth ${id} is not a width`);
      windowSidebars[id] = { width };
    }
    changes.push("edgeWidth became windowSidebars");
  }
  if (railWidth !== undefined) changes.push("railWidth was dropped because rail cards no longer exist");
  return { layout: { ...rest, windowSidebars }, changes };
}
