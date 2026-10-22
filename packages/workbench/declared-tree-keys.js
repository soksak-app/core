// Keyboard movement between the nodes of a declared tree (docs/spec/declared-ui.md, Tree keys). The keys act on the label control and
// the expand control of a node. The focus target of a node is its label control when that control is enabled, otherwise the expand
// control of its branch; a node with neither has no focus target. Keys reach the commands through the binder that the section passes in.

/** The command that moves focus between the nodes of a tree. */
export const MOVE = "core.declared-ui.tree.move";
/** The command that requests the expanded state of a branch from its source. */
export const EXPAND = "core.declared-ui.tree.expand";

const ROLES = ["label", "expand"];
// Node.DOCUMENT_POSITION_PRECEDING: the other node precedes the reference node. The value is fixed by the DOM standard.
const DOCUMENT_POSITION_PRECEDING = 2;

/** The trees whose keys are bound, so a redraw of a tree does not bind its keys again. */
const connected = new WeakSet();

const pathKey = (path) => JSON.stringify(path);

/** The label control of a node, or the expand control of its branch: the controls that a tree node draws with a role. */
const isNodeControl = (el) => ROLES.includes(el?.dataset?.role);

/**
 * The focus targets of a drawn tree box, in drawing order: {path, el} of each visible node that has one. The expand control is the target
 * of a node whose label control is absent or disabled; the expand control stays in the row before the label.
 */
export function focusTargets(box) {
  const targets = [];
  for (const control of box.querySelectorAll('[data-role="label"], [data-role="expand"]')) {
    if (control.dataset.role === "label") {
      if (!control.disabled) targets.push({ path: control.dataset.path, el: control });
    } else if (!hasEnabledLabel(control.parentElement)) {
      targets.push({ path: control.dataset.path, el: control });
    }
  }
  return targets;
}

/** Whether the row of a node holds an enabled label control. */
function hasEnabledLabel(row) {
  return Array.from(row.children).some((child) => child.dataset.role === "label" && !child.disabled);
}

/** The focus target of the node at path, or undefined when that node has none. */
const targetAt = (targets, path) => targets.find((target) => target.path === pathKey(path));

/** Moves focus to the focus target of the node at path for a key of the tree. A key at the end of its direction keeps focus. */
export function stepFocus(box, { tree, path, key }) {
  const targets = focusTargets(box);
  const here = targetAt(targets, path);
  if (here === undefined) throw new Error(`tree ${tree} path ${pathKey(path)} has no focus target`);
  const at = targets.indexOf(here);
  let next = null;
  switch (key) {
    case "ArrowDown":
      next = at + 1 < targets.length ? targets[at + 1] : here;
      break;
    case "ArrowUp":
      next = at > 0 ? targets[at - 1] : here;
      break;
    case "Home":
      next = targets[0];
      break;
    case "End":
      next = targets[targets.length - 1];
      break;
    case "ArrowRight": {
      // The first child with a focus target; a child is a node one level below path. With no such child, focus stays on the node.
      const child = targets.find((target) => isChildPath(target.path, path));
      next = child === undefined ? here : child;
      break;
    }
    case "ArrowLeft":
      // The parent node of a root node is none, so focus stays on a root node.
      next = path.length === 1 ? here : targetAt(targets, path.slice(0, -1));
      if (next === undefined) throw new Error(`tree ${tree} path ${pathKey(path)} has a parent with no focus target`);
      break;
    default:
      throw new Error(`tree ${tree} has no move for the key ${key}`);
  }
  next.el.focus();
}

/** Whether the path of a target is one level below the parent path. */
function isChildPath(childPath, parentPath) {
  const parts = JSON.parse(childPath);
  return parts.length === parentPath.length + 1 && parentPath.every((key, index) => parts[index] === key);
}

/**
 * Binds the arrow keys, Home and End of a tree box to the commands of the rows of Tree keys. A key with a modifier is not handled.
 * A handled key calls preventDefault. bind is the binder of the section: bind(element, name, params, options).
 */
export function connectTreeKeys(box, { bind, statusId, tree }) {
  if (connected.has(box)) return;
  connected.add(box);
  const plan = (event) => planOf(event, { box, statusId, tree });
  const handles = (name) => (event) => {
    const planned = plan(event);
    if (planned === null || planned.name !== name) return false;
    event.preventDefault();
    return true;
  };
  bind(box, MOVE, (event) => plan(event).params, { event: "keydown", when: handles(MOVE) });
  bind(box, EXPAND, (event) => plan(event).params, { event: "keydown", when: handles(EXPAND) });
}

/** The command and parameters that a keydown runs on a tree, or null when the key is not handled. */
function planOf(event, { box, statusId, tree }) {
  if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return null;
  const control = event.target;
  if (!box.contains(control) || !isNodeControl(control)) return null;
  const path = JSON.parse(control.dataset.path);
  const expand = Array.from(control.parentElement.children).find((child) => child.dataset.role === "expand");
  const branch = expand !== undefined;
  const expanded = branch && expand.dataset.expanded === "true";
  const move = { name: MOVE, params: { status: statusId, tree, path, key: event.key } };
  const expandTo = (value) => ({ name: EXPAND, params: { status: statusId, tree, path, expanded: value } });
  if (event.key === "ArrowRight") {
    // A leaf has no row for ArrowRight, so the key is not handled there.
    if (!branch) return null;
    return expanded ? move : expandTo(true);
  }
  if (event.key === "ArrowLeft") return expanded ? expandTo(false) : move;
  if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") return move;
  return null;
}

/** The tree box that draws the tree of key, found through one of its controls, or null when no control of it is drawn. */
export function treeBox(body, tree) {
  const control = Array.from(body.querySelectorAll('[data-role="label"], [data-role="expand"]')).find((el) => el.dataset.key === tree);
  return control === undefined ? null : control.closest(".declared-tree");
}

/**
 * Runs redraw, which draws the body again, and keeps keyboard focus when the redraw removes the focused tree control. Focus moves to the
 * focus target of the nearest node that precedes the removed one and still has a focus target; otherwise to the first focus target of the
 * tree; otherwise the body keeps focus.
 */
export function redrawKeepingFocus(body, redraw) {
  const focused = document.activeElement;
  // A list row also draws a label control, which is not a tree node; only a control inside a tree box is kept.
  const oldBox = body.contains(focused) && isNodeControl(focused) ? focused.closest(".declared-tree") : null;
  const was = oldBox === null ? null : focused;
  const tree = was?.dataset.key;
  const before = oldBox === null ? [] : focusTargets(oldBox);
  // The targets that precede the focused control in drawing order, nearest last.
  const preceding = before.filter((target) => was.compareDocumentPosition(target.el) & DOCUMENT_POSITION_PRECEDING);
  redraw();
  if (was === null || was.isConnected) return;
  const box = treeBox(body, tree);
  const after = box === null ? [] : focusTargets(box);
  const nearest = preceding.map((target) => targetAt(after, JSON.parse(target.path))).reverse().find((target) => target !== undefined);
  const next = nearest !== undefined ? nearest : after[0];
  // Without a next focus target the removal leaves focus on the document body (the focus fixup of the document).
  if (next !== undefined) next.el.focus();
}
