/**
 * Pane layout over shared grid lines.
 *
 * There is no tree and no grouping. Two arrays of numbers own every coordinate:
 *
 *   xs   vertical grid lines, normalised 0..1
 *   ys   horizontal grid lines, normalised 0..1
 *
 * A pane is a span of indices into those arrays. Two panes that meet read the
 * same index, so a boundary is one number and cannot drift apart. Moving a line
 * moves every pane that references it; a pane that spans across the line is not
 * affected — for it the line is *virtual*, and a later split snaps to it.
 *
 * Splitting only ever replaces one pane with two, so the layout is always a
 * slicing (guillotine) floorplan. Closing preserves that property, which is what
 * keeps every pane closable: in a slicing floorplan a pane's sibling region
 * always tiles one of its sides exactly.
 */

export type Axis = 'x' | 'y';

/** `merge`: a dragged line snaps to a neighbour and the two become one line. */
export type SnapMode = 'merge' | 'off';

/** Which axis a close tries first when filling the freed space. */
export type FillOrder = 'v' | 'h';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaneInit {
  id: string;
  /** Column span over `xs`. `c0 < c1`. */
  c0: number;
  c1: number;
  /** Row span over `ys`. `r0 < r1`. */
  r0: number;
  r1: number;
  /** A fixed pane is never split, never closed, and never fills a neighbour. */
  fixed?: boolean;
  /** Anything the host wants to carry along. Never read by this library. */
  data?: unknown;
}

export interface Pane extends PaneInit {
  fixed: boolean;
}

export interface SoksakState {
  xs: number[];
  ys: number[];
  panes: PaneInit[];
}

export interface SoksakOptions {
  /** Corridor between panes, in px. Half of it is the outer margin. Default 24. */
  gap?: number;
  /** Smallest pane edge, in px. Splitting and dragging both respect it. Default 96. */
  minSize?: number;
  /** Smallest grab area, in px. Kept independent of `gap` so a zero gap is still grabbable. Default 11. */
  grabSize?: number;
  /** How close a dragged line must come to a neighbour to snap onto it, in px. Default 7. */
  snapDistance?: number;
  snap?: SnapMode;
  fillOrder?: FillOrder;
  width?: number;
  height?: number;
}

/** A grab area. Exists only where the line is a real boundary. */
export interface Divider extends Rect {
  key: string;
  axis: Axis;
  line: number;
}

/**
 * A drawn boundary. Every line yields one `virtual: true` rule spanning the whole
 * plane plus one `virtual: false` rule per stretch where panes actually break on it.
 * Draw the virtual one faintly and the real ones solid.
 */
export interface Rule extends Rect {
  key: string;
  axis: Axis;
  line: number;
  virtual: boolean;
}

/**
 * A fixed-width band standing on a grid line, taking room from the panes.
 *
 * It may only stand on a *clean* line — one no pane spans across — because a
 * pane that crossed it would be cut in two by the band. `cleanLines` reports
 * which lines qualify and `nearestCleanLine` finds the closest one.
 */
export interface Station {
  axis: Axis;
  line: number;
  /** Total room the band takes, in px. Its drawn rect is inset by half a corridor, like a pane. */
  size: number;
}

/** Which neighbours would take over a pane's space, and from which side. */
export interface Fill {
  side: 'below' | 'above' | 'right' | 'left';
  panes: Pane[];
}

type SpanKey = 'c0' | 'c1' | 'r0' | 'r1';
type Span = { c0: number; c1: number; r0: number; r1: number };

const KEYS: Record<Axis, [SpanKey, SpanKey]> = { x: ['c0', 'c1'], y: ['r0', 'r1'] };
const CROSS: Record<Axis, [SpanKey, SpanKey]> = { x: ['r0', 'r1'], y: ['c0', 'c1'] };
const EPS = 1e-9;

const clamp = (v: number, lo: number, hi: number): number =>
  lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));

export class Soksak {
  private xs: number[];
  private ys: number[];
  private list: Pane[];
  private w: number;
  private h: number;
  private seq = 0;
  private sliceMemo = new Map<string, boolean>();

  private stationAt: Station | null = null;

  gap: number;
  minSize: number;
  grabSize: number;
  snapDistance: number;
  snap: SnapMode;
  fillOrder: FillOrder;

  /** Without a state, starts as a single pane filling the plane. */
  constructor(state?: SoksakState, options: SoksakOptions = {}) {
    this.gap = options.gap ?? 24;
    this.minSize = options.minSize ?? 96;
    this.grabSize = options.grabSize ?? 11;
    this.snapDistance = options.snapDistance ?? 7;
    this.snap = options.snap ?? 'merge';
    this.fillOrder = options.fillOrder ?? 'v';
    this.w = options.width ?? 0;
    this.h = options.height ?? 0;

    if (state) {
      this.xs = [...state.xs];
      this.ys = [...state.ys];
      this.list = state.panes.map((p) => ({ ...p, fixed: p.fixed ?? false }));
    } else {
      this.xs = [0, 1];
      this.ys = [0, 1];
      this.list = [{ id: 'pane', c0: 0, c1: 1, r0: 0, r1: 1, fixed: false }];
    }
  }

  // ---- plane -------------------------------------------------------------

  resize(width: number, height: number): void {
    this.w = width;
    this.h = height;
  }

  get width(): number {
    return this.w;
  }

  get height(): number {
    return this.h;
  }

  get panes(): readonly Pane[] {
    return this.list;
  }

  pane(id: string): Pane | undefined {
    return this.list.find((p) => p.id === id);
  }

  /** Grid line coordinates, normalised 0..1. Read-only copies. */
  lines(axis: Axis): number[] {
    return [...this.arr(axis)];
  }

  toJSON(): SoksakState {
    return {
      xs: [...this.xs],
      ys: [...this.ys],
      panes: this.list.map((p) => ({ ...p })),
    };
  }

  static from(state: SoksakState, options?: SoksakOptions): Soksak {
    return new Soksak(state, options);
  }

  // ---- geometry ----------------------------------------------------------

  private arr(axis: Axis): number[] {
    return axis === 'x' ? this.xs : this.ys;
  }

  private size(axis: Axis): number {
    return axis === 'x' ? this.w : this.h;
  }

  /** Room left for the panes once a band on this axis has taken its own. */
  private usable(axis: Axis): number {
    const s = this.stationAt;
    return this.size(axis) - (s && s.axis === axis ? s.size : 0);
  }

  /**
   * Where a grid line falls in px. Lines at or past the band are pushed along by
   * its width, so the panes on either side of it keep their own proportions.
   */
  private pos(axis: Axis, index: number): number {
    const s = this.stationAt;
    const base = this.arr(axis)[index] * this.usable(axis);
    return s && s.axis === axis && index >= s.line ? base + s.size : base;
  }

  private get half(): number {
    return this.gap / 2;
  }

  /**
   * An interior pane edge is pulled back by half a corridor; an edge sitting on
   * the plane boundary is flush. Every rect in the library measures from here.
   */
  private edge(axis: Axis, index: number, side: 'lo' | 'hi'): number {
    const a = this.arr(axis);
    const s = this.stationAt;
    const flush = side === 'lo' ? index === 0 : index === a.length - 1;
    const inset = flush ? 0 : this.half;
    // On the far side of a band the pane starts after it, so read the shifted
    // position for that side rather than the line's own.
    const shifted = s && s.axis === axis && index === s.line && side === 'hi'
      ? a[index] * this.usable(axis)
      : this.pos(axis, index);
    return shifted + (side === 'lo' ? inset : -inset);
  }

  private inset(axis: Axis, index: number, side: 'lo' | 'hi'): number {
    const a = this.arr(axis);
    const flush = side === 'lo' ? index === 0 : index === a.length - 1;
    return flush ? 0 : this.half;
  }

  rectOf(pane: Pane): Rect {
    const x0 = this.edge('x', pane.c0, 'lo');
    const x1 = this.edge('x', pane.c1, 'hi');
    const y0 = this.edge('y', pane.r0, 'lo');
    const y1 = this.edge('y', pane.r1, 'hi');
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  rect(id: string): Rect | undefined {
    const p = this.pane(id);
    return p && this.rectOf(p);
  }

  rects(): Map<string, Rect> {
    return new Map(this.list.map((p) => [p.id, this.rectOf(p)]));
  }

  // ---- real and virtual stretches of a line ------------------------------

  private static merge(spans: [number, number][]): [number, number][] {
    spans.sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    for (const s of spans) {
      const top = out[out.length - 1];
      if (top && s[0] <= top[1]) top[1] = Math.max(top[1], s[1]);
      else out.push([s[0], s[1]]);
    }
    return out;
  }

  /** Index stretches where panes actually break on this line. */
  realSpans(axis: Axis, line: number): [number, number][] {
    const [lo, hi] = KEYS[axis];
    const [o0, o1] = CROSS[axis];
    const spans: [number, number][] = [];
    for (const a of this.list) {
      if (a[hi] !== line) continue;
      for (const b of this.list) {
        if (b[lo] !== line) continue;
        const s = Math.max(a[o0], b[o0]);
        const e = Math.min(a[o1], b[o1]);
        if (e > s) spans.push([s, e]);
      }
    }
    return Soksak.merge(spans);
  }

  /** True when no pane references the line at all — it survives only as a snap target. */
  isVirtual(axis: Axis, line: number): boolean {
    const [lo, hi] = KEYS[axis];
    return !this.list.some((p) => p[lo] === line || p[hi] === line);
  }

  // ---- clean lines and the band -----------------------------------------

  /**
   * Panes that span across this line. They are what makes it unclean: a band
   * standing here would cut them, and a pane cannot be in two places.
   */
  panesCrossing(axis: Axis, line: number): Pane[] {
    const [lo, hi] = KEYS[axis];
    return this.list.filter((p) => p[lo] < line && p[hi] > line);
  }

  /**
   * A line is clean when it is a boundary over the whole plane — no pane spans
   * across it. This is a structural fact about the spans, not a comparison of
   * coordinates, so there is no tolerance to get wrong and no drift to heal.
   */
  isCleanLine(axis: Axis, line: number): boolean {
    const a = this.arr(axis);
    if (!Number.isInteger(line) || line < 0 || line > a.length - 1) return false;
    return this.panesCrossing(axis, line).length === 0;
  }

  /** Every clean line, in order. The plane's own two edges are always clean. */
  cleanLines(axis: Axis): number[] {
    const out: number[] = [];
    for (let k = 0; k < this.arr(axis).length; k++) if (this.isCleanLine(axis, k)) out.push(k);
    return out;
  }

  /** The clean line nearest a normalised position. Ties go to the earlier line. */
  nearestCleanLine(axis: Axis, value: number): number | null {
    const a = this.arr(axis);
    let best: number | null = null;
    let distance = Infinity;
    for (const k of this.cleanLines(axis)) {
      const d = Math.abs(a[k] - value);
      if (d < distance) {
        best = k;
        distance = d;
      }
    }
    return best;
  }

  get station(): Station | null {
    return this.stationAt && { ...this.stationAt };
  }

  /** Stand a band on a clean line. Refuses an unclean one — see `nearestCleanLine`. */
  setStation(axis: Axis, line: number, size: number): boolean {
    if (!this.isCleanLine(axis, line)) return false;
    this.stationAt = { axis, line, size: Math.max(0, size) };
    return true;
  }

  clearStation(): void {
    this.stationAt = null;
  }

  /** The band's drawn rect, inset by half a corridor on each side exactly like a pane. */
  stationRect(): Rect | null {
    const s = this.stationAt;
    if (!s) return null;
    const at = this.arr(s.axis)[s.line] * this.usable(s.axis);
    const lo = at + this.half;
    const hi = at + s.size - this.half;
    return s.axis === 'x'
      ? { x: lo, y: 0, w: Math.max(0, hi - lo), h: this.h }
      : { x: 0, y: lo, w: this.w, h: Math.max(0, hi - lo) };
  }

  /** How many lines a pane spans across. Tells you how much finer its neighbours are. */
  crossings(pane: Pane): number {
    return Math.max(0, pane.c1 - pane.c0 - 1) + Math.max(0, pane.r1 - pane.r0 - 1);
  }

  /** Every boundary to draw: one full-plane virtual rule per line, plus its real stretches. */
  rules(): Rule[] {
    const out: Rule[] = [];
    for (const axis of ['x', 'y'] as Axis[]) {
      const a = this.arr(axis);
      const along = this.size(axis);
      const across = axis === 'x' ? this.h : this.w;
      const other: Axis = axis === 'x' ? 'y' : 'x';
      for (let k = 1; k < a.length - 1; k++) {
        const at = a[k] * along - 0.5;
        out.push(
          axis === 'x'
            ? { key: `vx:${k}`, axis, line: k, virtual: true, x: at, y: -this.half, w: 1, h: across + this.gap }
            : { key: `vy:${k}`, axis, line: k, virtual: true, x: -this.half, y: at, w: across + this.gap, h: 1 },
        );
        for (const [i0, i1] of this.realSpans(axis, k)) {
          const s = this.edge(other, i0, 'lo') - this.half;
          const e = this.edge(other, i1, 'hi') + this.half;
          out.push(
            axis === 'x'
              ? { key: `sx:${k}:${i0}`, axis, line: k, virtual: false, x: at, y: s, w: 1, h: e - s }
              : { key: `sy:${k}:${i0}`, axis, line: k, virtual: false, x: s, y: at, w: e - s, h: 1 },
          );
        }
      }
    }
    return out;
  }

  /** Grab areas. Only where a corridor exists — a virtual stretch has nothing to grab. */
  dividers(): Divider[] {
    const out: Divider[] = [];
    const hit = Math.max(this.gap, this.grabSize);
    for (const axis of ['x', 'y'] as Axis[]) {
      const a = this.arr(axis);
      const along = this.size(axis);
      const other: Axis = axis === 'x' ? 'y' : 'x';
      for (let k = 1; k < a.length - 1; k++) {
        for (const [i0, i1] of this.realSpans(axis, k)) {
          const s = this.edge(other, i0, 'lo');
          const e = this.edge(other, i1, 'hi');
          out.push(
            axis === 'x'
              ? { key: `x:${k}:${i0}`, axis, line: k, x: a[k] * along - hit / 2, y: s, w: hit, h: e - s }
              : { key: `y:${k}:${i0}`, axis, line: k, x: s, y: a[k] * along - hit / 2, w: e - s, h: hit },
          );
        }
      }
    }
    return out;
  }

  // ---- moving a line -----------------------------------------------------

  /** How far a line may travel before some pane hits `minSize`. */
  lineRange(axis: Axis, line: number): [number, number] {
    const a = this.arr(axis);
    const along = this.size(axis);
    const [lo, hi] = KEYS[axis];
    let min = a[line - 1];
    let max = a[line + 1];
    for (const p of this.list) {
      if (p[hi] === line) {
        const need = this.minSize + this.inset(axis, p[lo], 'lo') + this.inset(axis, line, 'hi');
        min = Math.max(min, a[p[lo]] + need / along);
      }
      if (p[lo] === line) {
        const need = this.minSize + this.inset(axis, line, 'lo') + this.inset(axis, p[hi], 'hi');
        max = Math.min(max, a[p[hi]] - need / along);
      }
    }
    return [min, max];
  }

  /**
   * Move one line. Every pane that reads it follows; panes that span across it do
   * not. A line may travel all the way onto its neighbour — panes that span the
   * pair stop it at `minSize` first, so nothing is ever squeezed flat.
   */
  moveLine(axis: Axis, line: number, value: number, allowSnap = true): number {
    const a = this.arr(axis);
    const along = this.size(axis);
    const [min, max] = this.lineRange(axis, line);
    let v = clamp(value, min, max);
    if (allowSnap && this.snap !== 'off') {
      for (const edge of [a[line - 1], a[line + 1]]) {
        if (edge >= min && edge <= max && Math.abs(v - edge) * along < this.snapDistance) v = edge;
      }
    }
    a[line] = v;
    this.sliceMemo.clear();
    return v;
  }

  /**
   * Put a line where the two panes beside it come out the same size. Not the
   * midpoint of the line coordinates — a pane on the plane edge carries the
   * corridor inset on one side only, so centring the line leaves it half a
   * corridor wider.
   */
  centerLine(axis: Axis, line: number): number {
    const a = this.arr(axis);
    const along = this.size(axis);
    const [lo, hi] = KEYS[axis];
    let start = a[line - 1];
    let end = a[line + 1];
    let insStart = this.inset(axis, line - 1, 'lo');
    let insEnd = this.inset(axis, line + 1, 'hi');
    for (const p of this.list) {
      if (p[hi] === line && a[p[lo]] >= start) {
        start = a[p[lo]];
        insStart = this.inset(axis, p[lo], 'lo');
      }
      if (p[lo] === line && a[p[hi]] <= end) {
        end = a[p[hi]];
        insEnd = this.inset(axis, p[hi], 'hi');
      }
    }
    return this.moveLine(axis, line, (start + end) / 2 + (insStart - insEnd) / (2 * along), false);
  }

  /**
   * Fold a line onto a neighbour it exactly coincides with. Refuses when a pane
   * spans the pair, which would leave that pane with no size — `minSize` keeps
   * that state from arising in the first place.
   */
  mergeCoincident(axis: Axis, line: number): boolean {
    if (this.snap === 'off') return false;
    const a = this.arr(axis);
    const [lo, hi] = KEYS[axis];
    const other = [line - 1, line + 1].find(
      (i) => i > 0 && i < a.length - 1 && Math.abs(a[i] - a[line]) < EPS,
    );
    if (other === undefined) return false;
    const at = (p: Pane, key: SpanKey): number => (p[key] === line ? other : p[key]);
    if (this.list.some((p) => at(p, lo) === at(p, hi))) return false;
    for (const p of this.list) {
      p[lo] = at(p, lo);
      p[hi] = at(p, hi);
    }
    a.splice(line, 1);
    for (const p of this.list) {
      if (p[lo] > line) p[lo]--;
      if (p[hi] > line) p[hi]--;
    }
    this.sliceMemo.clear();
    return true;
  }

  // ---- splitting ---------------------------------------------------------

  /**
   * Where to cut. Among the virtual lines the pane spans, take the one nearest
   * its centre that leaves both halves at least `minSize`; otherwise draw a new
   * line at the centre, pulled inside the feasible range. A single off-centre
   * virtual line must never lock a pane that has room.
   */
  private cutAt(pane: Pane, axis: Axis): { line: number; value: number; snapped: boolean } | null {
    if (pane.fixed) return null;
    const a = this.arr(axis);
    const along = this.size(axis);
    const [lo, hi] = KEYS[axis];
    const lowest = a[pane[lo]] + (this.minSize + this.inset(axis, pane[lo], 'lo') + this.half) / along;
    const highest = a[pane[hi]] - (this.minSize + this.half + this.inset(axis, pane[hi], 'hi')) / along;
    if (lowest > highest) return null;

    const mid = (a[pane[lo]] + a[pane[hi]]) / 2;
    let line = -1;
    for (let i = pane[lo] + 1; i < pane[hi]; i++) {
      if (a[i] < lowest || a[i] > highest) continue;
      if (line < 0 || Math.abs(a[i] - mid) < Math.abs(a[line] - mid)) line = i;
    }
    if (line >= 0) return { line, value: a[line], snapped: true };
    return { line: -1, value: clamp(mid, lowest, highest), snapped: false };
  }

  /** True when both halves would keep `minSize`. Equivalently: edge >= 2·minSize + gap. */
  canSplit(id: string, axis: Axis): boolean {
    const p = this.pane(id);
    return !!p && !!this.cutAt(p, axis);
  }

  /**
   * Cut one pane in two. The original keeps its identity and its near half, so a
   * live surface it owns survives; the new pane takes the far half. Panes that
   * span the new line only widen their span — they are not cut.
   *
   * The new pane carries no `data` unless you give it some. A host that hangs a
   * payload on its panes has to answer for the new one, and guessing on its
   * behalf — copying the source's payload — would hand two panes one surface.
   *
   * Returns the new pane's id, or null when there was no room.
   */
  split(id: string, axis: Axis, init: { id?: string; data?: unknown } = {}): string | null {
    const pane = this.pane(id);
    const cut = pane && this.cutAt(pane, axis);
    if (!pane || !cut) return null;
    const a = this.arr(axis);
    const [lo, hi] = KEYS[axis];

    let line = cut.line;
    if (line < 0) {
      line = a.findIndex((t) => t > cut.value + EPS);
      if (line < 0) line = a.length;
      a.splice(line, 0, cut.value);
      for (const p of this.list) {
        if (p[lo] >= line) p[lo]++;
        if (p[hi] >= line) p[hi]++;
      }
    }

    const fresh: Pane = {
      id: init.id ?? this.nextId(),
      c0: pane.c0,
      c1: pane.c1,
      r0: pane.r0,
      r1: pane.r1,
      fixed: false,
      data: init.data,
    };
    fresh[lo] = line;
    pane[hi] = line;
    this.list.push(fresh);
    this.sliceMemo.clear();
    return fresh.id;
  }

  private nextId(): string {
    let id: string;
    do {
      id = `pane-${++this.seq}`;
    } while (this.pane(id));
    return id;
  }

  // ---- closing -----------------------------------------------------------

  /**
   * Splitting only ever replaces one pane with two, so the layout is always a
   * slicing floorplan — a pinwheel cannot be reached. Closing has to keep that
   * property; the moment it breaks, panes appear that no neighbour can fill.
   */
  isSlicing(list: Span[] = this.list): boolean {
    const key = list
      .map((r) => `${r.c0},${r.c1},${r.r0},${r.r1}`)
      .sort()
      .join('|');
    const hit = this.sliceMemo.get(key);
    if (hit !== undefined) return hit;

    let out = list.length <= 1;
    if (!out) {
      outer: for (const [lo, hi] of [
        ['c0', 'c1'],
        ['r0', 'r1'],
      ] as [SpanKey, SpanKey][]) {
        for (const v of new Set(list.map((r) => r[hi]))) {
          const a = list.filter((r) => r[hi] <= v);
          const b = list.filter((r) => r[lo] >= v);
          if (a.length && b.length && a.length + b.length === list.length && this.isSlicing(a) && this.isSlicing(b)) {
            out = true;
            break outer;
          }
        }
      }
    }
    if (this.sliceMemo.size > 4000) this.sliceMemo.clear();
    this.sliceMemo.set(key, out);
    return out;
  }

  /**
   * Which neighbours would take the freed space. One pane need not match
   * exactly — a row of them may tile the side together — but the result has to
   * be slicing again, which is what keeps every pane closable. In a slicing
   * floorplan such a side always exists.
   */
  fill(id: string): Fill | null {
    const pane = this.pane(id);
    if (!pane || pane.fixed) return null;
    if (this.list.filter((p) => !p.fixed).length <= 1) return null;

    type Dir = { side: Fill['side']; hit: (p: Pane) => boolean; lo: SpanKey; hi: SpanKey; grow: SpanKey };
    const below: Dir = { side: 'below', hit: (p) => p.r0 === pane.r1, lo: 'c0', hi: 'c1', grow: 'r0' };
    const above: Dir = { side: 'above', hit: (p) => p.r1 === pane.r0, lo: 'c0', hi: 'c1', grow: 'r1' };
    const right: Dir = { side: 'right', hit: (p) => p.c0 === pane.c1, lo: 'r0', hi: 'r1', grow: 'c0' };
    const left: Dir = { side: 'left', hit: (p) => p.c1 === pane.c0, lo: 'r0', hi: 'r1', grow: 'c1' };
    const dirs = this.fillOrder === 'h' ? [right, left, below, above] : [below, above, right, left];

    for (const d of dirs) {
      const group = this.list
        .filter((p) => p !== pane && !p.fixed && d.hit(p) && p[d.lo] >= pane[d.lo] && p[d.hi] <= pane[d.hi])
        .sort((a, b) => a[d.lo] - b[d.lo]);
      if (!group.length) continue;

      let at = pane[d.lo];
      let tiles = true;
      for (const p of group) {
        if (p[d.lo] !== at) {
          tiles = false;
          break;
        }
        at = p[d.hi];
      }
      if (!tiles || at !== pane[d.hi]) continue;

      const after: Span[] = this.list
        .filter((p) => p !== pane)
        .map((p) => {
          const copy: Span = { c0: p.c0, c1: p.c1, r0: p.r0, r1: p.r1 };
          if (group.includes(p)) copy[d.grow] = pane[d.grow];
          return copy;
        });
      if (this.isSlicing(after)) return { side: d.side, panes: group };
    }
    return null;
  }

  canClose(id: string): boolean {
    return !!this.fill(id);
  }

  /** Remove a pane; its neighbours grow into the space. Returns false when nothing can fill it. */
  close(id: string): boolean {
    const pane = this.pane(id);
    const f = pane && this.fill(id);
    if (!pane || !f) return false;
    const grow: SpanKey =
      f.side === 'below' ? 'r0' : f.side === 'above' ? 'r1' : f.side === 'right' ? 'c0' : 'c1';
    for (const p of f.panes) p[grow] = pane[grow];
    this.list.splice(this.list.indexOf(pane), 1);
    this.sliceMemo.clear();
    return true;
  }

  /** Drop lines no pane references any more. Returns how many went. */
  tidy(): number {
    let dropped = 0;
    for (const axis of ['x', 'y'] as Axis[]) {
      const a = this.arr(axis);
      const [lo, hi] = KEYS[axis];
      for (let k = a.length - 2; k >= 1; k--) {
        if (!this.isVirtual(axis, k)) continue;
        a.splice(k, 1);
        for (const p of this.list) {
          if (p[lo] > k) p[lo]--;
          if (p[hi] > k) p[hi]--;
        }
        dropped++;
      }
    }
    if (dropped) this.sliceMemo.clear();
    return dropped;
  }

  /** How many lines exist that no pane references. */
  virtualCount(): number {
    let n = 0;
    for (const axis of ['x', 'y'] as Axis[]) {
      const a = this.arr(axis);
      for (let k = 1; k < a.length - 1; k++) if (this.isVirtual(axis, k)) n++;
    }
    return n;
  }
}
