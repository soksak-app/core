// Declared UI values of a sidebar section (docs/spec/declared-ui.md): the validator of a value, the drawing of its elements,
// and the display of a rejected value through showError and hideError. The validator collects every violation of a value and
// reports the one of the first row in the rejection table; within that row, the first occurrence in document order.
import { icon } from "./icons.js";
import { hideError, showError } from "./shown-errors.js";

/** The dom name of every control that a declared UI value draws (docs/spec/exposure.md). */
export const CONTROL_NAME = "core.sidebar.section.control";

/** The command of the expand control of a tree branch (docs/spec/declared-ui.md, binding). */
const EXPAND = "core.declared-ui.tree.expand";

const MAX_BYTES = 1048576;
const MAX_ROOT_ELEMENTS = 64;
const MAX_ITEMS = 1000;
const MAX_NODES = 5000;
const MAX_LEVELS = 16;
const MAX_TEXT = 500;
const MAX_KEY = 128;
const MAX_PARAM_KEYS = 16;
const MAX_PARAM_KEY = 64;
const MAX_PARAM_STRING = 1000;
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

// The rows of the rejection table in table order. A row with a lower index takes precedence over a later row.
const ROWS = [
  "size", "root", "elements", "rootCount", "elementObject", "itemObject", "nodeObject", "missingKind", "kindString",
  "unknownKind", "itemCount", "nodeCount", "levels", "textLength", "keyLength", "keyPattern", "paramKeys", "paramKeyLength",
  "paramStringLength", "paramValueType", "unknownField", "missing", "requiresCommand", "wrongType", "control", "duplicateKey",
  "commandNoOwner", "commandOwner", "commandUndeclared", "icon", "expandedLeaf", "treeHorizontal",
];
const RANK = Object.fromEntries(ROWS.map((name, index) => [name, index]));

/** A value that breaks a row of the rejection table. pointer is a JSON Pointer and reason is the text after it. */
export class DeclaredUIRejection extends Error {
  constructor(pointer, reason) {
    super(`${pointer}: ${reason}`);
    this.pointer = pointer;
    this.reason = reason;
  }
}

// Field rules of each object. needsCommand marks a field that requires command in the same object; branchOnly marks a field
// that is allowed only on a branch of a tree.
const KEY = { type: "key", required: true };
const TEXT = { type: "text", required: true };
const COMMAND = { type: "command" };
const PARAMS = { type: "params" };
const ICON = { type: "icon" };
const BOOLEAN = { type: "boolean" };
const ITEM_SPEC = {
  key: KEY,
  label: TEXT,
  command: COMMAND,
  params: { type: "params", needsCommand: true },
  icon: ICON,
  enabled: { type: "boolean", needsCommand: true },
  selected: BOOLEAN,
  detail: { type: "text" },
};
const NODE_SPEC = {
  key: KEY,
  label: TEXT,
  command: COMMAND,
  params: { type: "params", needsCommand: true },
  icon: ICON,
  enabled: { type: "boolean", needsCommand: true },
  expanded: { type: "boolean", branchOnly: true },
  selected: BOOLEAN,
  children: { type: "children" },
};
const ELEMENT_SPECS = {
  button: { key: KEY, label: TEXT, command: { type: "command", required: true }, params: PARAMS, icon: ICON, enabled: BOOLEAN },
  list: { key: KEY, empty: TEXT, items: { type: "items", required: true } },
  tree: { key: KEY, empty: TEXT, nodes: { type: "nodes", required: true } },
  "status-line": { key: KEY, text: TEXT },
};

/** The quoted form of a name or value in a reason: an escaped JSON string, cut to 128 code points with the closing quote kept. */
function slot(text) {
  const body = JSON.stringify(String(text)).slice(1, -1);
  const quoted = `"${body}"`;
  if ([...quoted].length <= 128) return quoted;
  return `"${[...body].slice(0, 125).join("")}…"`;
}

/** A JSON Pointer token of a key. */
const token = (key) => String(key).replace(/~/g, "~0").replace(/\//g, "~1");

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isBranch = (node) => Array.isArray(node.children) && node.children.length > 0;

function countNodes(nodes) {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (isPlainObject(node) && Array.isArray(node.children)) count += countNodes(node.children);
  }
  return count;
}

/** Collects the violations of one value and keeps the one of the first row, and the first occurrence of that row. */
class Violations {
  constructor() {
    this.best = null;
  }

  fail(row, pointer, reason) {
    const rank = RANK[row];
    if (this.best === null || rank < this.best.rank) this.best = { rank, pointer, reason };
  }
}

function checkParams(violations, params, path) {
  const keys = Object.keys(params);
  if (keys.length > MAX_PARAM_KEYS) violations.fail("paramKeys", path, `exceeds ${MAX_PARAM_KEYS} keys`);
  for (const key of keys) {
    const keyPath = `${path}/${token(key)}`;
    if ([...key].length > MAX_PARAM_KEY) violations.fail("paramKeyLength", keyPath, `exceeds ${MAX_PARAM_KEY} code points`);
    const value = params[key];
    if (typeof value === "string") {
      if ([...value].length > MAX_PARAM_STRING) violations.fail("paramStringLength", keyPath, `exceeds ${MAX_PARAM_STRING} code points`);
    } else if (!(typeof value === "number" && Number.isFinite(value)) && typeof value !== "boolean" && value !== null) {
      violations.fail("paramValueType", keyPath, "params values must be string, finite number, boolean or null");
    }
  }
}

function checkCommand(violations, name, path, ctx) {
  const dot = name.indexOf(".");
  if (dot < 0) {
    violations.fail("commandNoOwner", path, `command ${slot(name)} must be named ${slot(`${ctx.owner}.${name}`)}`);
  } else if (name.slice(0, dot) !== ctx.owner) {
    violations.fail("commandOwner", path, `command ${slot(name)} is not a command of plugin ${slot(ctx.owner)}`);
  } else if (!ctx.declared(name)) {
    violations.fail("commandUndeclared", path, `undeclared command ${slot(name)}`);
  }
}

/** Checks one field of an object. Field rows are checked in the order of the keys of the object, which is document order. */
function checkField(violations, obj, pointer, name, rule, ctx, siblings, level) {
  const path = `${pointer}/${token(name)}`;
  const value = obj[name];
  if (rule.needsCommand && !Object.hasOwn(obj, "command")) {
    violations.fail("requiresCommand", pointer, `${slot(name)} requires command`);
  }
  if (rule.branchOnly && !isBranch(obj)) {
    violations.fail("expandedLeaf", path, "expanded is allowed only on a branch");
  }
  switch (rule.type) {
    case "key": {
      if (typeof value !== "string") {
        violations.fail("wrongType", path, `${slot(name)} must be string`);
        return;
      }
      if ([...value].length > MAX_KEY) violations.fail("keyLength", path, `exceeds ${MAX_KEY} code points`);
      else if (!KEY_PATTERN.test(value)) {
        violations.fail("keyPattern", path, `key must be 1 to ${MAX_KEY} code points of A-Z, a-z, 0-9, ., _, : or -`);
      }
      if (siblings) {
        if (siblings.has(value)) violations.fail("duplicateKey", path, `duplicate key ${slot(value)}`);
        siblings.add(value);
      }
      return;
    }
    case "text": {
      if (typeof value !== "string") {
        violations.fail("wrongType", path, `${slot(name)} must be string`);
        return;
      }
      if ([...value].length > MAX_TEXT) violations.fail("textLength", path, `exceeds ${MAX_TEXT} code points`);
      if (CONTROL_CHARACTER.test(value)) violations.fail("control", path, `${slot(name)} contains a control character`);
      return;
    }
    case "command": {
      if (typeof value !== "string") {
        violations.fail("wrongType", path, `${slot(name)} must be string`);
        return;
      }
      checkCommand(violations, value, path, ctx);
      return;
    }
    case "icon": {
      if (typeof value !== "string") {
        violations.fail("wrongType", path, `${slot(name)} must be string`);
        return;
      }
      if (!ctx.hasIcon(value)) violations.fail("icon", path, `unknown icon ${slot(value)}`);
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") violations.fail("wrongType", path, `${slot(name)} must be boolean`);
      return;
    }
    case "params": {
      if (!isPlainObject(value)) {
        violations.fail("wrongType", path, `${slot(name)} must be object`);
        return;
      }
      checkParams(violations, value, path);
      return;
    }
    case "items": {
      if (!Array.isArray(value)) {
        violations.fail("wrongType", path, `${slot(name)} must be array`);
        return;
      }
      if (value.length > MAX_ITEMS) violations.fail("itemCount", path, `exceeds ${MAX_ITEMS} items`);
      const siblings = new Set();
      value.forEach((item, index) => {
        const itemPath = `${path}/${index}`;
        if (!isPlainObject(item)) violations.fail("itemObject", itemPath, "list item must be an object");
        else checkObject(violations, item, itemPath, ITEM_SPEC, ctx, siblings, level, false);
      });
      return;
    }
    case "nodes":
    case "children": {
      if (!Array.isArray(value)) {
        violations.fail("wrongType", path, `${slot(name)} must be array`);
        return;
      }
      if (rule.type === "nodes" && countNodes(value) > MAX_NODES) violations.fail("nodeCount", path, `exceeds ${MAX_NODES} nodes`);
      checkNodes(violations, value, path, ctx, rule.type === "nodes" ? 1 : level + 1);
      return;
    }
    default:
      throw new Error(`unknown field rule ${rule.type}`);
  }
}

/** Checks one list of tree nodes; level is the level of these nodes (root nodes are level 1). */
function checkNodes(violations, nodes, path, ctx, level) {
  const siblings = new Set();
  nodes.forEach((node, index) => {
    const nodePath = `${path}/${index}`;
    if (level > MAX_LEVELS) violations.fail("levels", nodePath, `exceeds ${MAX_LEVELS} levels`);
    if (!isPlainObject(node)) violations.fail("nodeObject", nodePath, "tree node must be an object");
    else checkObject(violations, node, nodePath, NODE_SPEC, ctx, siblings, level, false);
  });
}

/** Checks one object: its unknown fields, then its missing fields, then each of its fields in document order. */
function checkObject(violations, obj, pointer, spec, ctx, siblings, level, allowKind) {
  const keys = Object.keys(obj);
  for (const name of keys) {
    if (!Object.hasOwn(spec, name) && !(allowKind && name === "kind")) {
      violations.fail("unknownField", pointer, `unknown field ${slot(name)}`);
    }
  }
  for (const name of Object.keys(spec)) {
    if (spec[name].required && !keys.includes(name)) violations.fail("missing", pointer, `missing ${slot(name)}`);
  }
  for (const name of keys) {
    if (Object.hasOwn(spec, name)) checkField(violations, obj, pointer, name, spec[name], ctx, siblings, level);
  }
}

function checkElement(violations, element, pointer, ctx, siblings) {
  if (!isPlainObject(element)) {
    violations.fail("elementObject", pointer, "element must be an object");
    return;
  }
  if (!Object.hasOwn(element, "kind")) {
    violations.fail("missingKind", pointer, "missing kind");
    return;
  }
  if (typeof element.kind !== "string") {
    violations.fail("kindString", pointer, "kind must be a string");
    return;
  }
  if (!Object.hasOwn(ELEMENT_SPECS, element.kind)) {
    violations.fail("unknownKind", `${pointer}/kind`, `unknown kind ${slot(element.kind)}`);
    return;
  }
  if (element.kind === "tree" && ctx.orientation === "horizontal") {
    violations.fail("treeHorizontal", pointer, "tree cannot be drawn in a horizontal section");
  }
  checkObject(violations, element, pointer, ELEMENT_SPECS[element.kind], ctx, siblings, 0, true);
}

/** Validates a declared UI value. Returns { elements } when every rule holds, otherwise throws a DeclaredUIRejection. */
export function validateValue(value, options) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BYTES) {
    throw new DeclaredUIRejection("/", `exceeds ${MAX_BYTES} bytes`);
  }
  if (!isPlainObject(value)) throw new DeclaredUIRejection("/", "root must be an object");
  const ctx = { owner: options.owner, declared: options.declared, hasIcon: options.hasIcon, orientation: options.orientation };
  const violations = new Violations();
  for (const name of Object.keys(value)) {
    if (name !== "elements") violations.fail("unknownField", "/", `unknown field ${slot(name)}`);
  }
  if (!Object.hasOwn(value, "elements")) violations.fail("missing", "/", 'missing "elements"');
  else if (!Array.isArray(value.elements)) violations.fail("elements", "/elements", "elements must be an array");
  else {
    if (value.elements.length > MAX_ROOT_ELEMENTS) {
      violations.fail("rootCount", "/elements", `exceeds ${MAX_ROOT_ELEMENTS} elements`);
    }
    const siblings = new Set();
    value.elements.forEach((element, index) => checkElement(violations, element, `/elements/${index}`, ctx, siblings));
  }
  if (violations.best) throw new DeclaredUIRejection(violations.best.pointer, violations.best.reason);
  return { elements: value.elements };
}

/** The label of a list item or a tree node: its icon, its text, and the detail of a list item. */
function labelOf(item, label) {
  label.className = "declared-label";
  if (Object.hasOwn(item, "icon")) {
    const mark = document.createElement("span");
    mark.className = "declared-icon";
    mark.innerHTML = icon(item.icon);
    label.append(mark);
  }
  label.append(document.createTextNode(item.label));
  return label;
}

/** The label element of an item or a node: a button bound to its command when it has one, otherwise a static span. */
function labelElement(entry, { key, path, bind }) {
  if (!Object.hasOwn(entry, "command")) return labelOf(entry, document.createElement("span"));
  const label = document.createElement("button");
  label.type = "button";
  label.dataset.key = key;
  label.dataset.path = JSON.stringify(path);
  label.dataset.role = "label";
  label.dataset.expose = CONTROL_NAME;
  if (entry.enabled === false) label.disabled = true;
  bind(label, entry.command, entry.params, { event: "click" });
  return labelOf(entry, label);
}

function drawItem(listKey, item, bind) {
  const row = document.createElement("div");
  row.className = "declared-row";
  if (item.selected === true) row.dataset.selected = "true";
  row.append(labelElement(item, { key: listKey, path: [item.key], bind }));
  if (Object.hasOwn(item, "detail")) {
    const detail = document.createElement("span");
    detail.className = "declared-detail";
    detail.append(document.createTextNode(item.detail));
    row.append(detail);
  }
  return row;
}

function drawList(element, bind) {
  const box = document.createElement("div");
  box.className = "declared-list";
  if (element.items.length === 0) {
    const empty = document.createElement("span");
    empty.className = "declared-empty";
    empty.append(document.createTextNode(element.empty));
    box.append(empty);
    return box;
  }
  for (const item of element.items) box.append(drawItem(element.key, item, bind));
  return box;
}

/** The kept expanded state of the branch at path, which every branch of a drawn tree has. */
function keptOf(kept, tree, path) {
  const expanded = kept.get(tree)?.get(JSON.stringify(path));
  if (expanded === undefined) throw new Error(`tree ${tree} path ${JSON.stringify(path)} has no kept state`);
  return expanded;
}

/** The expand control of a branch. It requests the state opposite to the one the branch shows. */
function expandControl(tree, path, expanded, { statusId, bind }) {
  const control = document.createElement("button");
  control.type = "button";
  control.className = "declared-expand";
  control.dataset.key = tree;
  control.dataset.path = JSON.stringify(path);
  control.dataset.role = "expand";
  control.dataset.expose = CONTROL_NAME;
  const mark = document.createElement("span");
  mark.className = "declared-icon";
  mark.innerHTML = icon(expanded ? "chevron-down" : "chevron-right");
  control.append(mark);
  bind(control, EXPAND, { status: statusId, tree, path, expanded: !expanded }, { event: "click" });
  return control;
}

/** The nodes of one level below parent. A branch draws its children only while it is expanded. */
function drawNodes(tree, nodes, parent, ctx) {
  return nodes.map((node) => {
    const path = [...parent, node.key];
    const wrap = document.createElement("div");
    wrap.className = "declared-node";
    const row = document.createElement("div");
    row.className = "declared-row";
    if (node.selected === true) row.dataset.selected = "true";
    const branch = isBranch(node);
    const expanded = branch ? keptOf(ctx.kept, tree.key, path) : false;
    if (branch) row.append(expandControl(tree.key, path, expanded, ctx));
    row.append(labelElement(node, { key: tree.key, path, bind: ctx.bind }));
    wrap.append(row);
    if (branch && expanded) {
      const children = document.createElement("div");
      children.className = "declared-children";
      children.append(...drawNodes(tree, node.children, path, ctx));
      wrap.append(children);
    }
    return wrap;
  });
}

function drawTree(element, ctx) {
  const box = document.createElement("div");
  box.className = "declared-tree";
  if (element.nodes.length === 0) {
    const empty = document.createElement("span");
    empty.className = "declared-empty";
    empty.append(document.createTextNode(element.empty));
    box.append(empty);
    return box;
  }
  box.append(...drawNodes(element, element.nodes, [], ctx));
  return box;
}

/**
 * Draws the root elements of an accepted value into body, replacing its previous content. Every control is connected through
 * bind(element, name, params, options) of the binder, and carries the dom name and the control attributes. kept holds the expanded
 * state of each tree by its key and the path of each branch (settle).
 */
export function drawValue(body, elements, { statusId, bind, kept }) {
  const nodes = elements.map((element) => {
    if (element.kind === "list") return drawList(element, bind);
    if (element.kind === "tree") return drawTree(element, { statusId, bind, kept });
    throw new Error(`declared UI kind ${element.kind} is not drawn yet`);
  });
  body.replaceChildren(...nodes);
}

/**
 * The state of each declared UI status, keyed by its status name `<plugin>.<name>`. kept maps each tree key to the expanded state
 * of each branch by its path, and survives a rejection and a change of source. accepted maps each tree key to the plugin's expanded
 * value of each branch of the last accepted value, and is null when the last value was rejected or its source changed. view is the
 * section that draws the last accepted value, so the expand command draws it again.
 */
const sources = new Map();

function sourceOf(statusId) {
  let source = sources.get(statusId);
  if (source === undefined) {
    source = { kept: new Map(), accepted: null, view: null };
    sources.set(statusId, source);
  }
  return source;
}

/**
 * Computes the kept state of an accepted value from the baseline rules of docs/spec/declared-ui.md (status mapping). A branch that
 * is new takes the plugin's value. A branch that is not new takes the plugin's value when that value changed, and keeps its kept
 * state otherwise. Without a baseline, a branch with a kept state keeps it. A kept state whose path is not a branch is dropped.
 */
function settle(source, elements) {
  const kept = new Map();
  const accepted = new Map();
  for (const element of elements) {
    if (element.kind !== "tree") continue;
    const keptBranches = new Map();
    const pluginBranches = new Map();
    const visit = (nodes, parent) => {
      for (const node of nodes) {
        if (!isBranch(node)) continue;
        const path = [...parent, node.key];
        const key = JSON.stringify(path);
        const planned = node.expanded === true;
        const previous = source.kept.get(element.key)?.get(key);
        let value;
        if (source.accepted === null) {
          value = previous ?? planned;
        } else {
          const before = source.accepted.get(element.key)?.get(key);
          value = before === undefined || before !== planned ? planned : previous;
        }
        keptBranches.set(key, value);
        pluginBranches.set(key, planned);
        visit(node.children, path);
      }
    };
    visit(element.nodes, []);
    kept.set(element.key, keptBranches);
    accepted.set(element.key, pluginBranches);
  }
  return { kept, accepted };
}

/**
 * Receives a declared UI value of one status into the section body. An accepted value is drawn and withdraws the error display of
 * the status. A rejected value removes the previous tree and shows the rejection through showError, which writes the log line.
 */
export function receive(body, value, options) {
  const statusId = `${options.owner}.${options.status}`;
  const where = `declared UI ${statusId}`;
  const source = sourceOf(statusId);
  let elements;
  try {
    ({ elements } = validateValue(value, options));
  } catch (error) {
    if (!(error instanceof DeclaredUIRejection)) throw error;
    body.replaceChildren();
    source.accepted = null;
    source.view = null;
    showError(body, where, `${error.pointer}: ${error.reason}`);
    return false;
  }
  const settled = settle(source, elements);
  drawValue(body, elements, { statusId, bind: options.bind, kept: settled.kept });
  source.kept = settled.kept;
  source.accepted = settled.accepted;
  source.view = { body, elements, bind: options.bind };
  hideError(body, where);
  return true;
}

/**
 * Runs core.declared-ui.tree.expand: sets the kept expanded state of the branch at path in the tree of the status, and draws the
 * tree again. The branch must be drawn; otherwise the command fails. Running it again with the same arguments sets the same state.
 */
export function setTreeExpanded({ status, tree, path, expanded }) {
  const source = sources.get(status);
  const key = JSON.stringify(path);
  if (!source?.accepted?.get(tree)?.has(key)) throw new Error(`tree ${tree} path ${key} is not drawn`);
  source.kept.get(tree).set(key, expanded);
  const { body, elements, bind } = source.view;
  drawValue(body, elements, { statusId: status, bind, kept: source.kept });
}

/**
 * Ends the accepted value of a status when its source changes: the drawn tree is no longer the baseline, and the kept state of each
 * path stays. The caller clears the section until the first value of the new source is accepted.
 */
export function changeSource(statusId) {
  const source = sources.get(statusId);
  if (source === undefined) return;
  source.accepted = null;
  source.view = null;
}
