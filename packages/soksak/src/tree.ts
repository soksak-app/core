/**
 * The stored form of a grid: its canonical slicing tree
 * (packages/soksak/docs/layout.md#the-model).
 *
 * A card node is a leaf, a box node is a rectangle of the host around one inner
 * node, and a cut node divides its rectangle along an axis into kids, each with
 * the share of the extent of the cut that it takes. The lines and the cells are
 * derived from the tree after every change and never read back, so two cuts
 * whose lines meet by chance stay two cuts.
 */

import type { Axis } from './card.js';

/** A card of the tree. `width` and `height` are px sizes, as on a card of the cells. */
export interface CardNode {
  card: string;
  data?: unknown;
  fixed?: boolean;
  width?: number;
  height?: number;
}

/** A rectangle of the host around its inner node, such as a group card, with the data of the host. */
export interface BoxNode {
  box: string;
  data?: unknown;
  inner: TreeNode;
}

/** A kid of a cut: its node and the share of the extent of the cut that it takes. */
export interface Kid {
  share: number;
  node: TreeNode;
}

/** A cut along `cut` into its kids in their order. */
export interface CutNode {
  cut: Axis;
  kids: Kid[];
}

export type TreeNode = CardNode | BoxNode | CutNode;

export interface SoksakState {
  root: TreeNode;
}

/** The distance under which two coordinates are one line (R1), and the tolerance of the sum of the shares. */
export const EPS = 1e-9;

export const isCut = (node: TreeNode): node is CutNode => 'cut' in node;
export const isBox = (node: TreeNode): node is BoxNode => 'box' in node;
export const isCard = (node: TreeNode): node is CardNode => 'card' in node;

/** The id of a card or a box, and null for a cut. */
export const idOf = (node: TreeNode): string | null => (isCard(node) ? node.card : isBox(node) ? node.box : null);

const only = (value: object, allowed: readonly string[]): boolean => Object.keys(value).every((key) => allowed.includes(key));

const refuse = (why: string): never => {
  throw new TypeError(`soksak: ${why}`);
};

const notANode = (value: unknown): never => refuse(`the node ${JSON.stringify(value) ?? String(value)} is not a card, a box or a cut`);

/** Whether a value is a node of one of the three forms, with exactly the members of that form. */
function checkForm(value: unknown): asserts value is TreeNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) notANode(value);
  const node = value as Record<string, unknown>;
  if (typeof node.card === 'string' && only(node, ['card', 'data', 'fixed', 'width', 'height'])) {
    if (node.fixed !== undefined && typeof node.fixed !== 'boolean') notANode(value);
    for (const key of ['width', 'height'] as const) {
      if (node[key] !== undefined && !Number.isFinite(node[key])) notANode(value);
    }
    return;
  }
  if (typeof node.box === 'string' && 'inner' in node && only(node, ['box', 'data', 'inner'])) return;
  if ((node.cut === 'x' || node.cut === 'y') && Array.isArray(node.kids) && only(node, ['cut', 'kids'])) {
    for (const kid of node.kids as unknown[]) {
      if (!kid || typeof kid !== 'object' || !only(kid, ['share', 'node']) || !('node' in kid) || typeof (kid as Kid).share !== 'number') {
        notANode(value);
      }
    }
    return;
  }
  notANode(value);
}

/**
 * Rejects a state that is not a canonical slicing tree and names what is wrong;
 * nothing is converted. A state of the earlier form, which held the lines and
 * the cells, is refused with that name.
 */
export function checkState(state: SoksakState): void {
  if (!state || typeof state !== 'object') refuse(`the state ${JSON.stringify(state)} is not {root}`);
  if (['xs', 'ys', 'cards'].some((key) => key in state)) {
    refuse('the state holds xs, ys and cards, which is the earlier form; the state is {root}');
  }
  if ('paidBy' in state) refuse('the state holds paidBy, which the layout does not record; the state is {root}');
  const extra = Object.keys(state).filter((key) => key !== 'root');
  if (extra.length) refuse(`the state holds ${extra.join(', ')}; the state is {root}`);
  const seen = new Set<string>();
  const check = (value: unknown, path: string): void => {
    checkForm(value);
    const node = value;
    if (isCut(node)) {
      const bad = (why: string): never => refuse(`the cut ${path} is not canonical: ${why}`);
      if (node.kids.length < 2) bad('it has fewer than two kids');
      let sum = 0;
      node.kids.forEach((kid, i) => {
        if (!Number.isFinite(kid.share) || kid.share <= 0) bad(`the share of kid ${i} is ${String(kid.share)}`);
        sum += kid.share;
      });
      if (Math.abs(sum - 1) > EPS) bad(`its shares sum to ${String(sum)}`);
      node.kids.forEach((kid, i) => {
        const at = `${path}.${i}`;
        checkForm(kid.node);
        if (isCut(kid.node) && kid.node.cut === node.cut) refuse(`the cut ${at} is not canonical: it is a cut along the axis of its cut`);
        check(kid.node, at);
      });
      return;
    }
    const id = idOf(node) as string;
    if (!id) refuse('a card has no id');
    if (seen.has(id)) refuse(`card ${id} is stored twice`);
    seen.add(id);
    if (isBox(node)) check(node.inner, `${path}.inner`);
  };
  check(state.root, 'root');
}

/** A deep copy of a node. The data of the host is copied by reference, as the layout does not read it. */
export function cloneNode(node: TreeNode): TreeNode {
  if (isCut(node)) return { cut: node.cut, kids: node.kids.map((kid) => ({ share: kid.share, node: cloneNode(kid.node) })) };
  if (isBox(node)) return { box: node.box, ...(node.data !== undefined ? { data: node.data } : {}), inner: cloneNode(node.inner) };
  const out: CardNode = { card: node.card, fixed: node.fixed ?? false };
  if (node.data !== undefined) out.data = node.data;
  if (node.width !== undefined) out.width = node.width;
  if (node.height !== undefined) out.height = node.height;
  return out;
}

/** The card nodes of a node in the order of the tree. */
export function cardsOf(node: TreeNode, out: CardNode[] = []): CardNode[] {
  if (isCut(node)) for (const kid of node.kids) cardsOf(kid.node, out);
  else if (isBox(node)) cardsOf(node.inner, out);
  else out.push(node);
  return out;
}
