// 카드 사방 패널의 상태 모델(V5-115, docs/spec/example-model.md).
//
// 패널은 지정이다: 어떤 세트가 어느 변에 설지는 카드 데이터에 저장되고 활성 탭에서 다시
// 계산되지 않는다 — 그것이 플러그인 연동 좌측 사이드바와의 차이다. 폭·높이와 접힘도 같은
// 데이터에 저장되며, 세트가 삭제되어도 지정은 지워지지 않는다(조용한 삭제 금지 — 패널만
// 숨고 지정은 남는다). 이 모듈은 순수하게 카드 객체 위에서 동작하므로 판 없이 검사한다.

/** 패널이 설 수 있는 변. 각 변에 최대 하나다. */
export const PANEL_SIDES = ["top", "bottom", "left", "right"];

const assertSide = (side) => {
  if (!PANEL_SIDES.includes(side)) throw new Error(`unknown panel side ${String(side)}`);
};

/** 변의 현재 지정 상태. 지정이 없으면 null, 있으면 { set, size, collapsed } 를 돌려준다. */
export function panelState(card, side, defaults) {
  assertSide(side);
  const panel = card?.data?.panels?.[side];
  if (!panel || panel.set === null) return null;
  return {
    set: panel.set,
    // 기본값: 크기를 저장하지 않은 패널은 기본 크기로 연다.
    size: panel.size ?? defaults.size,
    collapsed: panel.collapsed === true,
  };
}

/** 변의 시각 상태: 명시 지정이 우선이고, 없으면 플러그인 연결(card-<side>)이 기본 지정이다.
 * 연결 해제는 지정이 아니다 — 명시 지정이 없고 연결도 없으면 패널은 없다. */
export function effectivePanel(card, side, defaults, linked) {
  assertSide(side);
  const own = panelState(card, side, defaults);
  if (own !== null) return own;
  const set = linked === null || linked === undefined ? null : linked.id;
  if (set === null || set === undefined) return null;
  return { set, size: defaults.size, collapsed: false };
}

/** 지정을 세트 객체로 해석한다. 세트가 없으면(dangling) null — 지정 id 는 보존된다. */
export function resolvePanelSet(card, side, sets) {
  const state = panelState(card, side, { size: 0 });
  if (state === null) return null;
  // 기본값: 해석에 실패한 지정은 패널을 숨긴다(null) — 지정 자체는 지우지 않는다.
  if (!Object.hasOwn(sets, state.set)) return null;
  return sets[state.set];
}

/** 변에 세트를 지정한다(또는 "off" 로 해지한다). 같은 변의 이전 지정을 덮는다. */
export function setPanel(card, side, set, sets) {
  assertSide(side);
  if (set !== "off" && !(set in sets)) throw new Error(`unknown set ${String(set)}`);
  // 기본값: 패널을 지정한 적 없는 카드에는 panels 객체가 없다 — 첫 지정이 만든다.
  if (card.data.panels === undefined) card.data.panels = {};
  if (set === "off") {
    delete card.data.panels[side];
  } else {
    // 기본값: 같은 변에 다시 지정할 때 저장된 크기·접힘을 이어받는다.
    const previous = card.data.panels[side] === undefined ? {} : card.data.panels[side];
    card.data.panels[side] = { ...previous, set };
  }
}

/** 변의 패널을 접거나 편다. 저장된 크기는 그대로 둔다. */
export function togglePanel(card, side, defaults) {
  const state = panelState(card, side, defaults);
  if (state === null) throw new Error(`panel ${String(side)} of card ${String(card?.id)} is not assigned`);
  card.data.panels[side] = { ...state, collapsed: !state.collapsed };
}

/** 변의 패널 크기를 정한다. 좌우는 폭, 상하는 높이이고 상한은 사방 공용이다. */
export function sizePanel(card, side, size, defaults) {
  const state = panelState(card, side, defaults);
  if (state === null) throw new Error(`panel ${String(side)} of card ${String(card?.id)} is not assigned`);
  if (!Number.isFinite(size) || size < defaults.min || size > defaults.max) {
    throw new Error(`panel size must be ${defaults.min} to ${defaults.max} points`);
  }
  card.data.panels[side] = { ...state, size: Math.round(size) };
}

/** core.grid 가 카드마다 보고할 형태. 지정된 변만 담는다. */
export function panelsReport(card, sets, defaults) {
  const report = {};
  for (const side of PANEL_SIDES) {
    const state = panelState(card, side, defaults);
    if (state !== null) report[side] = state;
  }
  return report;
}
