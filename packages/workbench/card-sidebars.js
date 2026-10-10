// Manages the per-side assignment and the layout inside a card. The derived set and the layout state are independent.
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
  // default: data.sidebars is an optional field, so the first save creates an empty record.
  card.data.sidebars ??= {};
  card.data.sidebars[side] = next;
}
export function effectiveSidebar(card, side, defaults, linked) {
  const own = state(card, side);
  if (Object.hasOwn(own, "size") && (own.size < defaults.min || own.size > defaults.max)) {
    throw new Error(`invalid sidebar size outside ${defaults.min} to ${defaults.max} points`);
  }
  // default: without an explicit choice, the default link of the active plugin is used, and without that the side is off (docs/spec/example-model.md).
  const set = Object.hasOwn(own, "set") ? own.set : linked?.id ?? null;
  if (set === "off" || set === null) return null;
  // default: an omitted size and collapsed are the declared default size and the expanded state (docs/spec/example-model.md).
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
/** A click inverts the visible state: a side that is shown collapsed (shownCollapsed) opens, and a side that is shown open collapses. */
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
  // A drag opens the side.
  store(card, side, { ...state(card, side), collapsed: false, size });
}

/**
 * The display size of the stored panel size, aligned to the device pixel grid of the screen. The card border, the divider, and the prepared surface rectangles use the same grid
 * (docs/spec/native-surfaces.md), so a size off the grid is drawn on the grid too. The stored size is not changed.
 */
export function deviceGridSize(size, ratio) {
  if (!Number.isFinite(size) || !Number.isFinite(ratio) || ratio <= 0) throw new Error("invalid sidebar size or device pixel ratio");
  return Math.round(size * ratio) / ratio;
}

// Applies the stored expansion choice to the current card space (docs/spec/example-model.md). It does not change the stored size and choice; it only decides the visible
// size (shownSize) and the automatic collapse caused by lack of space. prefer is the side operated last on each axis.
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
        // default: before any operation, the upper or left side opens first.
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
        // default: a collapsed side takes only the grip width, so it has no visible size (null).
        shownSize:Object.hasOwn(shown,side)?shown[side]:null};
    }
  }
  return result;
}

const SIDE_NAMES = { top: "위", bottom: "아래", left: "왼쪽", right: "오른쪽" };

/** The Korean names of the card sidebar sides. */
export function sideName(side) {
  const name = SIDE_NAMES[side];
  if (name === undefined) throw new Error(`unknown sidebar side ${side}`);
  return name;
}

/**
 * The status line text that tells about a side the user expanded but that is collapsed for lack of space. It is null when there is no such side. Pressing the grip does not
 * expand the side until space is available, so the status line shows that reason.
 */
export function spaceFoldText(presentation) {
  const sides = SIDEBAR_SIDES.filter((side) => presentation[side]?.autoCollapsed && !presentation[side].requestedCollapsed);
  return sides.length === 0 ? null : `${sides.map(sideName).join("·")} 사이드바: 공간 부족으로 접힘`;
}
