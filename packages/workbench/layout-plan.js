// The plan of an arrangement (docs/spec/cli.md#planning-an-arrangement): the request tree, its reading order, the resolution of its
// entries against the tabs of the plane, the group cards of the tree, and the most even grid of a count. The sizes of an arrangement come
// from the size rule of the layout library through `measure`, which the workbench builds on the operations of that rule; this module holds
// no size rule of its own.

import { sameJson } from "./layout-tree.js";

const DIRECTIONS = ["row", "column"];

/**
 * Reads a request tree, or throws the reason in the form `tree<path>: <reason>`. A group is {group: {name?}, tree}, whose tree is a split;
 * its name is trimmed and holds 1 to 40 characters.
 */
export function readTree(value, path = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`tree${path} must be an object`);
  if ("group" in value) {
    const { group, tree, ...rest } = value;
    const extra = Object.keys(rest).sort()[0];
    if (extra !== undefined) throw new Error(`tree${path} has the unknown member ${extra}`);
    if (!group || typeof group !== "object" || Array.isArray(group)) throw new Error(`tree${path}.group must be an object`);
    const { name, ...groupRest } = group;
    const unknown = Object.keys(groupRest).sort()[0];
    if (unknown !== undefined) throw new Error(`tree${path}.group has the unknown member ${unknown}`);
    const named = name === undefined ? undefined : readGroupName(name);
    // A group holds two or more cards, so its tree is a split.
    if (!tree || typeof tree !== "object" || !("direction" in tree)) throw new Error("a group of the tree holds at least two cards");
    return { group: { name: named }, tree: readTree(tree, `${path}.tree`) };
  }
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

/** Reads the name of a group card: its white space at both ends is removed, and it holds 1 to 40 Unicode scalar values. */
function readGroupName(name) {
  if (typeof name !== "string") throw new Error(`group name must be 1 to 40 characters: ${String(name)}`);
  const trimmed = name.trim();
  const count = [...trimmed].length;
  if (count < 1 || count > 40) throw new Error(`group name must be 1 to 40 characters: ${trimmed}`);
  return trimmed;
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

/** The cards of a tree in tree order; a group holds the cards of its tree. */
export function treeCards(tree) {
  if (tree.group) return treeCards(tree.tree);
  return tree.direction ? tree.children.flatMap(treeCards) : [tree];
}

/** The group nodes of a tree in pre-order: each group before the groups inside its tree. */
export function treeGroups(tree) {
  if (tree.group) return [tree, ...treeGroups(tree.tree)];
  return tree.direction ? tree.children.flatMap(treeGroups) : [];
}

/**
 * The indices of the cards of a tree in reading order: by the top and then the left edge of their planned frames. A child of an equal
 * share starts at k (size + corridor) / n of its split, so the order of the edges does not depend on the corridors, and the tree gives it
 * in a plane of one by one without corridors; edges within a millionth are one edge.
 */
export function readingOrder(tree) {
  const frames = [];
  const walk = (node, x, y, width, height) => {
    if (node.group) return walk(node.tree, x, y, width, height);
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
  // default: a tree whose frames do not fit still plans; the first candidate serves a count that measured no tree.
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
      // default: an entry that names no tab of the plane opens a new tab.
      const found = planeTabs.find((tab) => !taken.has(tab.tab) && tab.plugin === entry.plugin && sameJson(tab.params ?? null, entry.params));
      if (found) taken.add(found.tab);
      // default: no tab of the plane matches the entry, so the plan names no tab and the apply opens one.
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
 * Builds `tree` through `ops`, the operations of the size rule of the layout library on the content cards and group cards of the space
 * (docs/spec/groups.md#rule-of-sizes). `ids[k]` is the card of the k-th card of the tree in tree order, and `groupIds[g]` the group card
 * of the g-th group in pre-order: an identifier of the plane that the node keeps, or a new identifier. `ops` has `boxes()`, the group card
 * ids of the plane; `members(box)`, the content cards and group cards directly inside the group card `box`, or of the root for null;
 * `cards()`, the content card ids of the plane; `unwrap(id)`; `withdraw(id)`; `insert(target, side, node)`; `group(target, side, node,
 * {box, data, head})`; `setData(id, data)`; `head()`; `even()`; and `frame(id)`.
 *
 * A group card that no group of the tree keeps is unwrapped first. A kept group card is never unwrapped: it stays in place, its cards
 * other than the first card of its tree are withdrawn, and the tree is built inside it. A new group card is created by `group` around the
 * first card of its tree. The first card of the tree stays where the plane has it, and each split inserts its other children beside the
 * first unit of the child before, toward right or bottom, from the root inward; every cut is made even. It returns {frames, leader}: the
 * frames of the cards in tree order and the leader of the root level, which is the first unit of the tree.
 */
export function buildTree(ops, tree, ids, groupIds) {
  const leaves = treeCards(tree);
  const groups = treeGroups(tree);
  if (ids.length !== leaves.length) throw new Error(`the tree holds ${leaves.length} cards and ${ids.length} identifiers were given`);
  if (groupIds.length !== groups.length) throw new Error(`the tree holds ${groups.length} groups and ${groupIds.length} identifiers were given`);
  const leafId = new Map(leaves.map((leaf, index) => [leaf, ids[index]]));
  const boxOf = new Map(groups.map((group, index) => [group, groupIds[index]]));
  const boxes = ops.boxes();
  const kept = new Set(groupIds.filter((id) => boxes.includes(id)));
  const planned = new Set([...ids, ...groupIds]);
  for (const box of boxes) if (!kept.has(box)) ops.unwrap(box);
  // The units that the withdrawn nodes leave behind; an identifier that no withdrawn node holds is a card that arrives new.
  const left = new Map();
  // default: an identifier that no withdrawn node holds is a card that arrives new, as the comment above states.
  const arriving = (id) => left.get(id) ?? { card: id };
  // The unit at the top left of a node: a kept group card, or the card that a new group card starts with.
  const unitOf = (node) => {
    if (node.group) return kept.has(boxOf.get(node)) ? boxOf.get(node) : unitOf(node.tree);
    if (node.direction) return unitOf(node.children[0]);
    return leafId.get(node);
  };
  // The member of the level that holds the top left of a node: a group card for a group, else the card.
  const leaderOf = (node) => {
    if (node.group) return boxOf.get(node);
    if (node.direction) return leaderOf(node.children[0]);
    return leafId.get(node);
  };
  const side = (split) => (split.direction === "row" ? "right" : "bottom");
  const first = unitOf(tree);
  const rootMembers = ops.members(null);
  // default: the first unit of the tree stays in its place when the plane holds it, else another member of the plane stays.
  const stay = rootMembers.includes(first) ? first : (rootMembers.find((id) => planned.has(id)) ?? rootMembers[0]);
  for (const id of rootMembers) if (id !== stay) left.set(id, ops.withdraw(id));
  if (first !== stay) {
    ops.insert(stay, "left", arriving(first));
    left.set(stay, ops.withdraw(stay));
  }
  // The other children of a split go beside the unit of the child before them, from index `from` on.
  const chain = (split, from, prev) => {
    let target = prev;
    for (const child of split.children.slice(from)) {
      const unit = unitOf(child);
      ops.insert(target, side(split), arriving(unit));
      target = unit;
    }
  };
  const realize = (node) => {
    if (node.group) return realizeGroup(node);
    if (!node.direction) return undefined;
    chain(node, 1, unitOf(node.children[0]));
    return node.children.forEach(realize);
  };
  const realizeGroup = (node) => {
    const box = boxOf.get(node);
    const inner = node.tree;
    const data = { name: node.group.name, leader: leaderOf(inner) };
    if (kept.has(box)) {
      // The kept group card keeps its box: its members are withdrawn but one, which takes the first unit of the tree.
      const unit = unitOf(inner);
      const members = ops.members(box);
      // default: a unit that is not a member of the box takes the first planned member, or the first member when none is planned.
      const alone = members.includes(unit) ? unit : (members.find((id) => planned.has(id)) ?? members[0]);
      for (const id of members) if (id !== alone) left.set(id, ops.withdraw(id));
      if (unit !== alone) {
        ops.insert(alone, "left", arriving(unit));
        left.set(alone, ops.withdraw(alone));
      }
      ops.setData(box, data);
      chain(inner, 1, unit);
    } else {
      // A new group card is made around the first card of its tree and the first unit of its second child.
      const unit = unitOf(inner);
      const second = unitOf(inner.children[1]);
      ops.group(unit, side(inner), arriving(second), { box, data, head: ops.head() });
      chain(inner, 2, second);
    }
    return inner.children.forEach(realize);
  };
  realize(tree);
  ops.even();
  return { frames: ids.map((id) => ops.frame(id)), leader: leaderOf(tree) };
}

/**
 * The number of cards of an equal share along each axis for every card of a tree in tree order: a split multiplies the count of its
 * children along its own axis by the number of its children; a group takes the share of its tree.
 */
function shares(tree, along = { width: 1, height: 1 }) {
  if (tree.group) return shares(tree.tree, along);
  if (!tree.direction) return [along];
  const axis = tree.direction === "row" ? "width" : "height";
  const inner = { ...along, [axis]: along[axis] * tree.children.length };
  return tree.children.flatMap((child) => shares(child, inner));
}

/** The tree with the card at each place of tree order replaced by `cards[k]`, and each group named by `names[g]` in pre-order. */
function withCards(tree, cards, names = []) {
  let k = 0;
  let g = 0;
  const walk = (node) => {
    if (node.group) {
      const name = names[g];
      g += 1;
      return { group: { name }, tree: walk(node.tree) };
    }
    return node.direction ? { direction: node.direction, children: node.children.map(walk) } : cards[k++];
  };
  return walk(tree);
}

/** An entry in the form of a request: {tab} for an existing tab, else {plugin, params}. */
const requestEntry = ({ tab, plugin, params }) => (tab !== null ? { tab } : { plugin, params });

/**
 * The plan of an arrangement (docs/spec/cli.md#planning-an-arrangement). `request` is the parameters of core.layout.plan. `space`
 * describes the active space: `refusal`, the text of a cause that refuses every arrangement, or null; `tabs`, the tabs of the plane in
 * reading order `{tab, card, plugin, params}`; `plane` and `minimum`, sizes `{width, height}` in points; `entry(plugin, params)`, which
 * answers the params of a new tab or throws the refusal of the plugin or its params; `unsaved(tab)`; `groupNames`, the names of the group
 * cards of the space; `groupOf(card)`, the group card that holds a content card or null; `groupName(id)`; and `measure(tree)`, the frames
 * `{x, y, width, height}` in window points of the cards of the tree in tree order, which the operations of the size rule build on a
 * copy of the plane without the minimum, or the error of the layout library, which the plan states as its reason. The result holds the
 * answer of the plan, `ids`, the kept card of each card of the tree in tree order or null, and `groupIds`, the kept group card of each
 * group in pre-order or null, which an apply builds.
 */
export function planArrangement(request, space) {
  const refused = (reason) => ({
    feasible: false, tree: null, cards: [], plane: space.plane, minimum: space.minimum, kept: [], closed: [], reason, needed: null, proposal: null,
    ids: [], groupIds: [],
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
    // default: a request without params opens its tabs with the params null.
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

/**
 * The size refusal of the layout library (packages/soksak/docs/layout.md), the one error that a measure takes for a tree that does not
 * fit.
 */
const SIZE_REFUSAL = /^card \S+ would be \S+x\S+, below its minimum \S+x\S+$/;

/** The measure of a space that answers null for a tree that does not fit the plane and throws every other error of the layout
 * library, the test of the minimum, and the test of low cards. */
function sizing(space) {
  const { width, height } = space.minimum;
  return {
    // A tree that does not fit the plane is refused by the layout library with its size refusal, `card <id> would be <w>x<h>, below its
    // minimum <w>x<h>` (packages/soksak/docs/layout.md), which a card of a window sidebar meets before the content cards have no extent,
    // or is drawn with an empty card; the plan states the plane for both. Every other error of the measure is thrown, so a fault of the
    // operations is not taken for a plane that is too small.
    measure: (tree) => {
      let frames;
      try {
        frames = space.measure(tree);
      } catch (error) {
        if (SIZE_REFUSAL.test(error.message)) return null;
        throw error;
      }
      return frames.every((frame) => frame.width > 0 && frame.height > 0) ? frames : null;
    },
    fits: (frames) => frames.every((frame) => frame.width >= width && frame.height >= height),
    low: (frames) => frames.some((frame) => frame.height < height),
  };
}

/**
 * The group cards of a tree (docs/spec/cli.md#planning-an-arrangement). A group keeps the group card of the plane that holds the card its
 * first card in reading order keeps, when no earlier group keeps that group card; otherwise it is a new group card. A kept group card keeps
 * its name; a new one takes its name, or the smallest default name, the Korean word for group and a number, that no group of the space has, numbered in reading order of its first card.
 * It answers, for each group in pre-order, its kept group card or null and its name, and for each card the innermost group that holds it.
 */
function resolveGroups(tree, order, resolved, space) {
  const leaves = treeCards(tree);
  const groups = treeGroups(tree);
  const indexOf = new Map(leaves.map((leaf, index) => [leaf, index]));
  const place = [];
  order.forEach((index, n) => { place[index] = n; });
  const firstOf = (group) => Math.min(...treeCards(group).map((leaf) => place[indexOf.get(leaf)]));
  const taken = new Set(space.groupNames);
  const keptBy = new Set();
  const keep = new Map();
  const name = new Map();
  for (const group of [...groups].sort((a, b) => firstOf(a) - firstOf(b))) {
    const card = resolved.cards[firstOf(group)].card;
    const holder = card === null ? null : space.groupOf(card);
    const kept = holder !== null && !keptBy.has(holder) ? holder : null;
    keep.set(group, kept);
    if (kept !== null) {
      keptBy.add(kept);
      name.set(group, space.groupName(kept));
    } else if (group.group.name !== undefined) {
      name.set(group, group.group.name);
    } else {
      let n = 1;
      while (taken.has(`그룹 ${n}`)) n += 1;
      taken.add(`그룹 ${n}`);
      name.set(group, `그룹 ${n}`);
    }
  }
  const innermost = new Map();
  const walk = (node, holder) => {
    if (node.group) return walk(node.tree, node);
    if (node.direction) return node.children.forEach((child) => walk(child, holder));
    innermost.set(node, holder);
    return undefined;
  };
  walk(tree, null);
  return {
    groups,
    keep: (group) => keep.get(group),
    name: (group) => name.get(group),
    groupOf: (leaf) => (innermost.get(leaf) ? keep.get(innermost.get(leaf)) : null),
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
      needed: null, proposal: null, ids: [], groupIds: [] };
  }
  // resolved.cards[n] is the card of the tree at the place order[n] of tree order.
  const inTreeOrder = [];
  order.forEach((index, n) => { inTreeOrder[index] = resolved.cards[n]; });
  const groups = resolveGroups(tree, order, resolved, space);
  const requestTree = withCards(tree, inTreeOrder.map(({ tabs, active }) => ({ tabs: tabs.map(requestEntry), active })),
    groups.groups.map((group) => groups.name(group)));
  const cards = frames === null ? [] : order.map((index, n) => ({
    card: resolved.cards[n].card, frame: frames[index], tabs: resolved.cards[n].tabs, active: resolved.cards[n].active,
    group: groups.groupOf(leaves[index]),
  }));
  const result = {
    feasible: true, tree: requestTree, cards, plane: space.plane, minimum: space.minimum, kept: resolved.kept, closed: resolved.closed,
    reason: null, needed: null, proposal: null, ids: inTreeOrder.map(({ card }) => card),
    groupIds: groups.groups.map((group) => groups.keep(group)),
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
  // plane less count times what it lacks. The drawn sizes include the headers of the group cards, so no header is added here.
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
