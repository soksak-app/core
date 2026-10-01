// 카드 내부의 변별 지정과 배치를 관리한다. 파생 세트와 배치 상태는 독립적이다.
export const SIDEBAR_SIDES = ["top", "bottom", "left", "right"];
function assertSide(side) {
  if (!SIDEBAR_SIDES.includes(side)) throw new Error(`unknown sidebar side ${String(side)}`);
}
function state(card, side) {
  assertSide(side);
  if (!card?.data) throw new Error(`card ${String(card?.id)} has no content`);
  if (Object.hasOwn(card.data, "panels") || Object.hasOwn(card.data, "sidebar")) {
    throw new Error(`obsolete card sidebar state on card ${String(card.id)}`);
  }
  if (!Object.hasOwn(card.data, "sidebars")) return {};
  const sides = card.data.sidebars;
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(sides)) throw new Error("invalid card sidebars state");
  for (const [key, entry] of Object.entries(sides)) {
    if (!SIDEBAR_SIDES.includes(key) || !object(entry)) throw new Error("invalid card sidebar state");
    for (const field of Object.keys(entry)) {
      if (!["set", "size", "collapsed"].includes(field)) throw new Error(`invalid sidebar field ${field}`);
    }
    if (Object.hasOwn(entry, "set") && (typeof entry.set !== "string" || !entry.set || entry.set === "inherit")) {
      throw new Error("invalid sidebar set");
    }
    if (Object.hasOwn(entry, "size") && !Number.isFinite(entry.size)) throw new Error("invalid sidebar size");
    if (Object.hasOwn(entry, "collapsed") && typeof entry.collapsed !== "boolean") throw new Error("invalid sidebar collapsed state");
  }
  return Object.hasOwn(sides, side) ? sides[side] : {};
}
function store(card, side, next) {
  // 기본값: data.sidebars 는 선택 필드이므로 첫 저장에서 빈 기록을 만든다.
  card.data.sidebars ??= {};
  card.data.sidebars[side] = next;
}
export function effectiveSidebar(card, side, defaults, linked) {
  const own = state(card, side);
  if (Object.hasOwn(own, "size") && (own.size < defaults.min || own.size > defaults.max)) {
    throw new Error(`invalid sidebar size outside ${defaults.min} to ${defaults.max} points`);
  }
  // 기본값: 명시 선택이 없으면 활성 플러그인의 기본 연결을 쓰고, 그것도 없으면 그 면은 꺼진다(docs/spec/example-model.md).
  const set = Object.hasOwn(own, "set") ? own.set : linked?.id ?? null;
  if (set === "off" || set === null) return null;
  // 기본값: 생략한 size 와 collapsed 는 선언된 기본 크기와 펼친 상태다(docs/spec/example-model.md).
  return { set, size: own.size ?? defaults.size, collapsed: own.collapsed ?? false };
}
export function resolveSidebarSet(card, side, sets, defaults, linked) {
  const current = effectiveSidebar(card, side, defaults, linked);
  if (current === null) return null;
  if (!Object.hasOwn(sets, current.set)) throw new Error(`unknown sidebar set ${String(current.set)}`);
  return sets[current.set];
}
export function setSidebar(card, side, choice, sets) {
  const previous = state(card, side);
  if (choice !== "off" && choice !== "inherit" && !Object.hasOwn(sets, choice)) {
    throw new Error(`unknown sidebar set ${String(choice)}`);
  }
  const next = { ...previous };
  if (choice === "inherit") delete next.set;
  else next.set = choice;
  store(card, side, next);
}
export function toggleSidebar(card, side, defaults, linked) {
  const current = effectiveSidebar(card, side, defaults, linked);
  if (current === null) throw new Error(`card ${String(card.id)} has no ${String(side)} sidebar`);
  store(card, side, { ...state(card, side), collapsed: !current.collapsed });
}
export function sizeSidebar(card, side, size, defaults, linked) {
  const current = effectiveSidebar(card, side, defaults, linked);
  if (current === null) throw new Error(`card ${String(card.id)} has no ${String(side)} sidebar`);
  if (!Number.isFinite(size) || size < defaults.min || size > defaults.max) {
    throw new Error(`sidebar size must be ${defaults.min} to ${defaults.max} points`);
  }
  store(card, side, { ...state(card, side), size });
}

// 저장된 펼침 선택을 현재 카드 공간에 적용한다. 부족한 축의 요청만 자동으로 접는다.
export function presentSidebars(requested, rect, metrics) {
  const values=[rect.w,rect.h,metrics.header,metrics.footer,metrics.border,metrics.divider,metrics.minimum];
  if(values.some(value=>!Number.isFinite(value)||value<0)||metrics.minimum===0) throw new Error('invalid sidebar presentation geometry');
  const extent=side=>requested[side]?(requested[side].collapsed?metrics.divider:requested[side].size):0;
  const insufficient={
    width:rect.w-2*metrics.border-extent('left')-extent('right')<metrics.minimum,
    height:rect.h-2*metrics.border-metrics.header-metrics.footer-extent('top')-extent('bottom')<metrics.minimum,
  };
  return Object.fromEntries(Object.entries(requested).map(([side,state])=>{
    assertSide(side);
    if(!state||!Number.isFinite(state.size)||state.size<0||typeof state.collapsed!=='boolean') throw new Error('invalid sidebar presentation state');
    const axis=side==='left'||side==='right'?'width':'height';
    const autoCollapsed=!state.collapsed&&insufficient[axis];
    // 기본값: 없음. 표시 접힘은 요청한 접힘과 공간 부족에 따른 자동 접힘의 합이다.
    return [side,{...state,requestedCollapsed:state.collapsed,collapsed:state.collapsed||autoCollapsed,
      autoCollapsed,collapseReason:autoCollapsed?`insufficient-${axis}`:null}];
  }));
}
