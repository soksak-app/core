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
/** 클릭은 보이는 상태를 뒤집는다: 접혀 보이는 면(shownCollapsed)은 열고, 열려 보이는 면은 접는다. */
export function toggleSidebar(card, side, defaults, linked, shownCollapsed) {
  const current = effectiveSidebar(card, side, defaults, linked);
  if (current === null) throw new Error(`card ${String(card.id)} has no ${String(side)} sidebar`);
  if (typeof shownCollapsed !== "boolean") throw new Error(`card ${String(card.id)} has no shown ${String(side)} sidebar state`);
  store(card, side, { ...state(card, side), collapsed: !shownCollapsed });
}
export function sizeSidebar(card, side, size, defaults, linked) {
  const current = effectiveSidebar(card, side, defaults, linked);
  if (current === null) throw new Error(`card ${String(card.id)} has no ${String(side)} sidebar`);
  if (!Number.isFinite(size) || size < defaults.min || size > defaults.max) {
    throw new Error(`sidebar size must be ${defaults.min} to ${defaults.max} points`);
  }
  // 끌기는 면을 연다.
  store(card, side, { ...state(card, side), collapsed: false, size });
}

/**
 * 저장된 패널 크기를 화면의 장치 pixel 격자에 맞춘 표시 크기. 카드 테두리, divider, 준비한 표면 사각형은 같은 격자를
 * 쓰므로(docs/spec/native-surfaces.md) 격자 밖의 크기도 격자 위에 그린다. 저장된 크기는 바꾸지 않는다.
 */
export function deviceGridSize(size, ratio) {
  if (!Number.isFinite(size) || !Number.isFinite(ratio) || ratio <= 0) throw new Error("invalid sidebar size or device pixel ratio");
  return Math.round(size * ratio) / ratio;
}

// 저장된 펼침 선택을 현재 카드 공간에 적용한다(docs/spec/example-model.md). 저장된 크기와 선택은 바꾸지 않고, 보이는
// 크기(shownSize)와 공간 부족에 따른 자동 접힘만 정한다. prefer 는 축마다 마지막으로 조작한 면이다.
export function presentSidebars(requested, rect, metrics, prefer = {}) {
  const values=[rect.w,rect.h,metrics.header,metrics.footer,metrics.border,metrics.divider,metrics.minimum,metrics.sidebarMinimum];
  if(values.some(value=>!Number.isFinite(value)||value<0)||metrics.minimum===0) throw new Error('invalid sidebar presentation geometry');
  for(const [side,state] of Object.entries(requested)){
    assertSide(side);
    if(!state||!Number.isFinite(state.size)||state.size<0||typeof state.collapsed!=='boolean') throw new Error('invalid sidebar presentation state');
  }
  const result={};
  const axes={width:['left','right'],height:['top','bottom']};
  for(const [axis,sides] of Object.entries(axes)){
    const present=sides.filter(side=>requested[side]);
    const chosenFolded=present.filter(side=>requested[side].collapsed);
    const open=present.filter(side=>!requested[side].collapsed);
    const extent=axis==='width'?rect.w-2*metrics.border:rect.h-2*metrics.border-metrics.header-metrics.footer;
    const room=extent-metrics.minimum-chosenFolded.length*metrics.divider;
    const shown={};
    const total=open.reduce((sum,side)=>sum+requested[side].size,0);
    if(total<=room){
      for(const side of open) shown[side]=requested[side].size;
    }else{
      const scaled=Object.fromEntries(open.map(side=>[side,requested[side].size*room/total]));
      if(open.every(side=>scaled[side]>=metrics.sidebarMinimum)){
        Object.assign(shown,scaled);
      }else{
        // 기본값: 조작 전에는 위나 왼쪽을 먼저 연다.
        const first=open.includes(prefer[axis])?prefer[axis]:open[0];
        const alone=Math.min(requested[first].size,room-(open.length-1)*metrics.divider);
        if(alone>=metrics.sidebarMinimum) shown[first]=alone;
      }
    }
    for(const side of present){
      const state=requested[side];
      const autoCollapsed=!state.collapsed&&!Object.hasOwn(shown,side);
      result[side]={...state,requestedCollapsed:state.collapsed,collapsed:state.collapsed||autoCollapsed,
        autoCollapsed,collapseReason:autoCollapsed?`insufficient-${axis}`:null,
        // 기본값: 접힌 면은 손잡이 폭만 차지하므로 보이는 크기가 없다(null).
        shownSize:Object.hasOwn(shown,side)?shown[side]:null};
    }
  }
  return result;
}

const SIDE_NAMES = { top: "위", bottom: "아래", left: "왼쪽", right: "오른쪽" };

/** 카드 사이드바 면의 한국어 이름. */
export function sideName(side) {
  const name = SIDE_NAMES[side];
  if (name === undefined) throw new Error(`unknown sidebar side ${side}`);
  return name;
}

/**
 * 사용자가 펼쳤지만 공간이 부족해 접혀 있는 면을 알리는 상태 줄 문구. 그런 면이 없으면 null 이다. 손잡이를 눌러도
 * 공간이 생기기 전에는 펼쳐지지 않으므로 상태 줄이 그 이유를 보인다.
 */
export function spaceFoldText(presentation) {
  const sides = SIDEBAR_SIDES.filter((side) => presentation[side]?.autoCollapsed && !presentation[side].requestedCollapsed);
  return sides.length === 0 ? null : `${sides.map(sideName).join("·")} 사이드바: 공간 부족으로 접힘`;
}
