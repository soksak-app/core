// The plan of an arrangement (docs/spec/cli.md#planning-an-arrangement): the request tree, its reading order, the resolution of its
// entries against the tabs of the plane, and the most even grid of a count. The sizes of an arrangement come from the size rule of the
// layout library through `measure`, which the workbench builds on the operations insert and withdraw of that rule; this module holds
// no size rule of its own.

import { sameJson } from "./layout-tree.js";

const DIRECTIONS = ["row", "column"];

/** Reads a request tree, or throws the reason in the form `tree<path>: <reason>`. */
export function readTree(value, path = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`tree${path} must be an object`);
  if ("direction" in value) {
    const { direction, children, ...rest } = value;
    const extra = Object.keys(rest).sort()[0];
    if (extra !== undefined) throw new Error(`tree${path} has the unknown member ${extra}`);
    if (!DIRECTIONS.includes(direction)) throw new Error(`tree${path}.direction must be row or column`);
    if (!Array.isArray(children) || children.length < 2) throw new Error(`tree${path}.children must hold at least two nodes`);
    return {
      direction,
      children: children.map((child, index) => {
        const node = readTree(child, `${path}.children[${index}]`);
        if (node.direction === direction) throw new Error(`tree${path}.children[${index}] is a ${direction} inside a ${direction}`);
        return node;
      }),
    };
  }
  const { tabs, active = 0, ...rest } = value;
  const extra = Object.keys(rest).sort()[0];
  if (extra !== undefined) throw new Error(`tree${path} has the unknown member ${extra}`);
  if (!Array.isArray(tabs) || tabs.length === 0) throw new Error(`tree${path}.tabs must be a non-empty list`);
  if (!Number.isInteger(active) || active < 0 || active >= tabs.length) throw new Error(`tree${path}.active must be an index of tabs`);
  return { tabs: tabs.map((entry, index) => readEntry(entry, `${path}.tabs[${index}]`)), active };
}

/** Reads an entry {tab} or {plugin, params?}; an omitted params is null. */
function readEntry(entry, path) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`tree${path} must be an object`);
  if ("tab" in entry) {
    if (Object.keys(entry).length !== 1 || typeof entry.tab !== "string" || entry.tab === "") {
      throw new Error(`tree${path} must be {tab} with a tab identifier`);
    }
    return { tab: entry.tab };
  }
  const { plugin, params = null, ...rest } = entry;
  const extra = Object.keys(rest).sort()[0];
  if (extra !== undefined) throw new Error(`tree${path} has the unknown member ${extra}`);
  if (typeof plugin !== "string" || plugin === "") throw new Error(`tree${path} must be {tab} or {plugin, params?}`);
  if (params !== null && (typeof params !== "object" || Array.isArray(params))) throw new Error(`tree${path}.params must be an object`);
  return { plugin, params };
}

/** The cards of a tree in tree order. */
export function treeCards(tree) {
  return tree.direction ? tree.children.flatMap(treeCards) : [tree];
}

/**
 * The indices of the cards of a tree in reading order: by the top and then the left edge of their planned frames. A child of an equal
 * share starts at k (size + corridor) / n of its split, so the order of the edges does not depend on the corridors, and the tree gives it
 * in a plane of one by one without corridors; edges within a millionth are one edge.
 */
export function readingOrder(tree) {
  const frames = [];
  const walk = (node, x, y, width, height) => {
    if (!node.direction) return void frames.push({ x, y });
    const n = node.children.length;
    node.children.forEach((child, k) => (node.direction === "row"
      ? walk(child, x + (k * width) / n, y, width / n, height)
      : walk(child, x, y + (k * height) / n, width, height / n)));
  };
  walk(tree, 0, 0, 1, 1);
  return frames.map((frame, index) => ({ frame, index }))
    .sort((a, b) => (Math.abs(a.frame.y - b.frame.y) > 1e-6 ? a.frame.y - b.frame.y : a.frame.x - b.frame.x))
    .map(({ index }) => index);
}

/** The tree of `count` cards in `rows` rows: each row holds `count / rows` cards rounded down or up, the larger rows first. */
export function gridTree(count, rows, entry) {
  const card = () => ({ tabs: [{ ...entry }], active: 0 });
  const sizes = Array.from({ length: rows }, (_, row) => Math.floor(count / rows) + (row < count % rows ? 1 : 0));
  const rowNode = (size) => (size === 1 ? card() : { direction: "row", children: Array.from({ length: size }, card) });
  return rows === 1 ? rowNode(count) : { direction: "column", children: sizes.map(rowNode) };
}

/**
 * The most even grid of `count` cards with `entry`, `{tree, frames, feasible}`: of the grids of 1 to `count` rows whose cards `fits`
 * finds at the minimum, the one whose cards are nearest to a square, the smallest mean |ln(width / height)|, and of equal ones the grid
 * with fewer rows; when none fits, the grid nearest to a square of those that `measure` builds, which is not feasible, and the grid of one
 * row when it builds none. `measure(tree)` answers the frames of the cards in tree order or null; a grid whose cards are lower than the
 * minimum ends the search, because more rows only make them lower.
 */
export function evenGrid(count, entry, measure, fits, low) {
  let best = null;
  let nearest = null;
  for (let rows = 1; rows <= count; rows += 1) {
    const tree = gridTree(count, rows, entry);
    const frames = measure(tree);
    if (frames === null) continue;
    const skew = frames.reduce((sum, frame) => sum + Math.abs(Math.log(frame.width / frame.height)), 0) / count;
    const feasible = fits(frames);
    if (feasible && (!best || skew < best.skew)) best = { tree, frames, feasible, skew };
    if (!nearest || skew < nearest.skew) nearest = { tree, frames, feasible, skew };
    if (low(frames)) break;
  }
  const { skew, ...grid } = best ?? nearest ?? { tree: gridTree(count, 1, entry), frames: null, feasible: false };
  return grid;
}

/**
 * Resolves the cards of a tree, in reading order, against the tabs of the plane, in reading order `[{tab, card, plugin, params}]`
 * (docs/spec/cli.md#planning-an-arrangement). It answers each card with its kept card or null and its tabs `{tab, plugin, params}`,
 * `tab` null for a new tab, and the tabs that no entry names or takes, kept at the end of the first card or closed with `close`.
 * It throws for an entry {tab} that names no tab of the plane or a tab that an earlier entry names.
 */
export function resolveCards(cards, planeTabs, { close = false } = {}) {
  const byId = new Map(planeTabs.map((tab) => [tab.tab, tab]));
  const named = new Set();
  for (const card of cards) {
    for (const entry of card.tabs) {
      if (entry.tab === undefined) continue;
      if (!byId.has(entry.tab)) throw new Error(`tab ${entry.tab} is not a tab of the active space`);
      if (named.has(entry.tab)) throw new Error(`tab ${entry.tab} stands twice in the tree`);
      named.add(entry.tab);
    }
  }
  const taken = new Set(named);
  const resolved = cards.map((card) => ({
    active: card.active,
    tabs: card.tabs.map((entry) => {
      if (entry.tab !== undefined) {
        const { tab, plugin, params } = byId.get(entry.tab);
        return { tab, plugin, params };
      }
      const found = planeTabs.find((tab) => !taken.has(tab.tab) && tab.plugin === entry.plugin && sameJson(tab.params ?? null, entry.params));
      if (found) taken.add(found.tab);
      return { tab: found?.tab ?? null, plugin: entry.plugin, params: entry.params };
    }),
  }));
  const keptCards = new Set();
  for (const card of resolved) {
    const first = card.tabs.find(({ tab }) => tab !== null);
    const holder = first && byId.get(first.tab).card;
    card.card = holder !== undefined && !keptCards.has(holder) ? holder : null;
    if (card.card !== null) keptCards.add(card.card);
  }
  const seed = resolved.find((card) => card.card === null && !card.tabs.some(({ tab }) => tab !== null));
  if (seed) {
    const free = planeTabs.find(({ card }) => !keptCards.has(card));
    if (free) {
      seed.card = free.card;
      keptCards.add(free.card);
    }
  }
  const rest = planeTabs.filter(({ tab }) => !taken.has(tab)).map(({ tab, plugin, params }) => ({ tab, plugin, params }));
  if (!close && rest.length > 0) resolved[0].tabs.push(...rest);
  return { cards: resolved, kept: close ? [] : rest.map(({ tab }) => tab), closed: close ? rest.map(({ tab }) => tab) : [] };
}


/**
 * Builds `tree` through `ops`, the operations of the size rule of the layout library on the content cards of the space: `cards()`, the
 * content card ids, `withdraw(id)`, which returns what left, `insert(target, side, node)` with a node `{card}` or what withdraw
 * returned, `even()` and `frame(id)`. `ids[k]` is the card of the k-th card of the tree in tree order: an id of the plane that the card
 * keeps, or a new id. One card of the plane stays and every other card is withdrawn; the first card of the tree takes its place, the
 * first card of each split stands where the split stands and the other children are inserted beside it toward right or bottom from the
 * root inward, and every cut is made even. A withdrawn card that the tree keeps arrives with its data. It returns the frames of the
 * cards of the tree in tree order.
 */
export function buildTree(ops, tree, ids) {
  const leaves = treeCards(tree);
  if (ids.length !== leaves.length) throw new Error(`the tree holds ${leaves.length} cards and ${ids.length} identifiers were given`);
  const plane = ops.cards();
  const stay = ids.find((id) => plane.includes(id)) ?? plane[0];
  const left = new Map();
  for (const id of plane) {
    if (id !== stay) left.set(id, ops.withdraw(id));
  }
  const arriving = (id) => left.get(id) ?? { card: id };
  if (ids[0] !== stay) {
    ops.insert(stay, "left", arriving(ids[0]));
    left.set(stay, ops.withdraw(stay));
  }
  const idOf = new Map(leaves.map((leaf, index) => [leaf, ids[index]]));
  const first = (node) => (node.direction ? first(node.children[0]) : node);
  const place = (node) => {
    if (!node.direction) return;
    const side = node.direction === "row" ? "right" : "bottom";
    let target = idOf.get(first(node.children[0]));
    for (const child of node.children.slice(1)) {
      const id = idOf.get(first(child));
      ops.insert(target, side, arriving(id));
      target = id;
    }
    node.children.forEach(place);
  };
  place(tree);
  ops.even();
  return ids.map((id) => ops.frame(id));
}

/**
 * The number of cards of an equal share along each axis for every card of a tree in tree order: a split multiplies the count of its
 * children along its own axis by the number of its children.
 */
function shares(tree, along = { width: 1, height: 1 }) {
  if (!tree.direction) return [along];
  const axis = tree.direction === "row" ? "width" : "height";
  const inner = { ...along, [axis]: along[axis] * tree.children.length };
  return tree.children.flatMap((child) => shares(child, inner));
}

/** The tree with the card at each place of tree order replaced by `cards[k]`. */
function withCards(tree, cards) {
  let k = 0;
  const walk = (node) => (node.direction ? { direction: node.direction, children: node.children.map(walk) } : cards[k++]);
  return walk(tree);
}

/** An entry in the form of a request: {tab} for an existing tab, else {plugin, params}. */
const requestEntry = ({ tab, plugin, params }) => (tab !== null ? { tab } : { plugin, params });

/**
 * The plan of an arrangement (docs/spec/cli.md#planning-an-arrangement). `request` is the parameters of core.layout.plan. `space`
 * describes the active space: `refusal`, the text of a cause that refuses every arrangement, or null; `tabs`, the tabs of the plane in
 * reading order `{tab, card, plugin, params}`; `plane` and `minimum`, sizes `{width, height}` in points; `entry(plugin, params)`, which
 * answers the params of a new tab or throws the refusal of the plugin or its params; `unsaved(tab)`; and `measure(tree)`, the frames
 * `{x, y, width, height}` in window points of the cards of the tree in tree order, which the operations of the size rule build on a
 * copy of the plane without the minimum, or the refusal of the layout library for a tree whose cards have no extent in the plane. The
 * result holds the answer of the plan and `ids`, the kept card of each card of the tree in tree order or null, which an apply builds.
 */
export function planArrangement(request, space) {
  const refused = (reason) => ({
    feasible: false, tree: null, cards: [], plane: space.plane, minimum: space.minimum, kept: [], closed: [], reason, needed: null, proposal: null, ids: [],
  });
  const { tree: asked, count, plugin } = request;
  if (asked !== undefined && (count !== undefined || plugin !== undefined || request.params !== undefined)) {
    throw new Error("core.layout.plan takes tree or count with plugin, not both");
  }
  if (asked === undefined && (count === undefined || plugin === undefined)) throw new Error("core.layout.plan needs tree, or count with plugin");
  if (count !== undefined && !(Number.isInteger(count) && count >= 1)) throw new Error("count must be a whole number of at least 1");
  if (space.refusal !== null) return refused(space.refusal);
  const tools = sizing(space);
  let tree, frames;
  try {
    if (asked !== undefined) {
      tree = readTree(asked);
      frames = tools.measure(tree);
    } else ({ tree, frames } = evenGrid(count, { plugin, params: request.params ?? null }, tools.measure, tools.fits, tools.low));
    for (const leaf of treeCards(tree)) {
      for (const entry of leaf.tabs) {
        if (entry.tab === undefined) entry.params = space.entry(entry.plugin, entry.params);
      }
    }
  } catch (error) {
    return refused(error.message);
  }
  return judged(tree, frames, request.close === true, space, tools);
}

/** The measure of a space that answers null for a tree whose cards have no extent, the test of the minimum, and the test of low cards. */
function sizing(space) {
  const { width, height } = space.minimum;
  return {
    // A tree whose cards have no extent in the plane is refused by the layout library or drawn with an empty card; the plan states the
    // plane instead of the text of the library.
    measure: (tree) => {
      let frames;
      try {
        frames = space.measure(tree);
      } catch {
        return null;
      }
      return frames.every((frame) => frame.width > 0 && frame.height > 0) ? frames : null;
    },
    fits: (frames) => frames.every((frame) => frame.width >= width && frame.height >= height),
    low: (frames) => frames.some((frame) => frame.height < height),
  };
}

/** The plan of a tree that reads and checks: its resolution against the plane and the judgement of its frames by the minimum. */
function judged(tree, frames, close, space, tools) {
  const order = readingOrder(tree);
  const leaves = treeCards(tree);
  let resolved;
  try {
    resolved = resolveCards(order.map((index) => leaves[index]), space.tabs, { close });
  } catch (error) {
    return { feasible: false, tree: null, cards: [], plane: space.plane, minimum: space.minimum, kept: [], closed: [], reason: error.message,
      needed: null, proposal: null, ids: [] };
  }
  // resolved.cards[n] is the card of the tree at the place order[n] of tree order.
  const inTreeOrder = [];
  order.forEach((index, n) => { inTreeOrder[index] = resolved.cards[n]; });
  const requestTree = withCards(tree, inTreeOrder.map(({ tabs, active }) => ({ tabs: tabs.map(requestEntry), active })));
  const cards = frames === null ? [] : order.map((index, n) => ({ card: resolved.cards[n].card, frame: frames[index], tabs: resolved.cards[n].tabs, active: resolved.cards[n].active }));
  const result = {
    feasible: true, tree: requestTree, cards, plane: space.plane, minimum: space.minimum, kept: resolved.kept, closed: resolved.closed,
    reason: null, needed: null, proposal: null, ids: inTreeOrder.map(({ card }) => card),
  };
  const unsaved = resolved.closed.find((tab) => space.unsaved(tab));
  if (unsaved !== undefined) return { ...result, feasible: false, reason: `tab ${unsaved} has unsaved changes; core.layout.close asks the person` };
  const round = Math.round;
  const planeText = `${round(space.plane.width)} × ${round(space.plane.height)} points`;
  const sources = order.map((index, n) => ({ tabs: resolved.cards[n].tabs.map(requestEntry), active: resolved.cards[n].active }));
  if (frames === null) {
    return { ...result, feasible: false, reason: `the cards of the tree have no extent in the plane of ${planeText}`, proposal: propose(sources, close, space, tools) };
  }
  const small = cards.findIndex(({ frame }) => !tools.fits([frame]));
  if (small < 0) return result;
  // A card of an equal share is drawn at (plane - corridors) / count on each axis, so the plane at which it meets the minimum is the
  // plane less count times what it lacks.
  const counts = shares(tree);
  // The need is rounded up to a whole point after a rounding to a millionth, so a sum of equal shares stays its whole number.
  const need = (axis) => Math.ceil(Math.round(Math.max(...frames.map((frame, k) => space.plane[axis] - counts[k][axis] * (frame[axis] - space.minimum[axis]))) * 1e6) / 1e6);
  const { frame } = cards[small];
  return {
    ...result,
    feasible: false,
    reason: `card ${small + 1} of the tree would be ${round(frame.width)} × ${round(frame.height)} points, below the minimum ` +
      `${round(space.minimum.width)} × ${round(space.minimum.height)} points; the tree needs a plane of ${need("width")} × ${need("height")} ` +
      `points and the plane is ${planeText}`,
    needed: { width: need("width"), height: need("height") },
    proposal: propose(sources, close, space, tools),
  };
}

/**
 * The nearest arrangement that can be built, {tree, cards}: the most even grid of the number of cards of the tree, each card taking the
 * entries of one card of the tree in reading order, or the most even grid of the largest number of cards that fits, whose last card also
 * takes the entries of the cards that do not fit; null when no grid of one card fits. A grid of one card fewer in the same rows has cards
 * at least as large, so a bisection over the counts gives the largest count that fits.
 */
function propose(sources, close, space, tools) {
  const placeholder = { plugin: "", params: null };
  const grid = (count) => evenGrid(count, placeholder, tools.measure, tools.fits, tools.low);
  let best = grid(sources.length);
  if (!best.feasible) {
    let [lo, hi] = [0, sources.length];
    best = null;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const found = grid(mid);
      if (found.feasible) [lo, best] = [mid, found];
      else hi = mid;
    }
    if (best === null) return null;
  }
  const count = treeCards(best.tree).length;
  const merged = sources.slice(0, count - 1);
  const rest = sources.slice(count - 1);
  merged.push({ tabs: rest.flatMap(({ tabs }) => tabs), active: rest[0].active });
  const placed = [];
  readingOrder(best.tree).forEach((index, n) => { placed[index] = merged[n]; });
  const planned = judged(withCards(best.tree, placed), best.frames, close, space, tools);
  return { tree: planned.tree, cards: planned.cards };
}
