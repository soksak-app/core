// Declared UI values of a sidebar section (docs/spec/declared-ui.md): the validator of a value, the drawing of its elements,
// and the display of a rejected value through showError and hideError. The validator collects every violation of a value and
// reports the one of the first row in the rejection table; within that row, the first occurrence in document order.
import { drawList } from "@soksak/plugin-api";
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
  "commandNoOwner", "commandOwner", "commandUndeclared", "icon", "expandedLeaf",
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
  detail: { type: "text" },
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
  checkObject(violations, element, pointer, ELEMENT_SPECS[element.kind], ctx, siblings, 0, true);
}

/** Validates a declared UI value. Returns { elements } when every rule holds, otherwise throws a DeclaredUIRejection. */
export function validateValue(value, options) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BYTES) {
    throw new DeclaredUIRejection("/", `exceeds ${MAX_BYTES} bytes`);
  }
  if (!isPlainObject(value)) throw new DeclaredUIRejection("/", "root must be an object");
  const ctx = { owner: options.owner, declared: options.declared, hasIcon: options.hasIcon };
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

/** Connects an element to its command. The binder reads the parameters at each run, so a redraw only updates them. */
const CONNECTIONS = new WeakMap();

function connect(element, name, params, bind) {
  const state = CONNECTIONS.get(element);
  if (state === undefined) {
    CONNECTIONS.set(element, { name, params });
    bind(element, name, () => CONNECTIONS.get(element).params, { event: "click" });
    return;
  }
  if (state.name !== name) throw new Error(`control is connected to ${state.name}, not ${name}`);
  state.params = params;
}

const paramsOf = (entry) => (Object.hasOwn(entry, "params") ? entry.params : {});

/** The key of an entry in a keyed drawing: its key and its command. Keys hold no space, so the two parts cannot be confused. */
const entryKey = (entry) => `${entry.key} ${Object.hasOwn(entry, "command") ? entry.command : ""}`;

/** The first child of el that has none of the given classes. */
function childWithout(el, classes) {
  return Array.from(el.children).find((child) => !classes.some((name) => child.classList.contains(name)));
}

function childOf(el, name) {
  return Array.from(el.children).find((child) => child.classList.contains(name));
}

/** Writes the icon and the text of an element. */
function paintContent(el, entry) {
  el.replaceChildren();
  if (Object.hasOwn(entry, "icon")) {
    const mark = document.createElement("span");
    mark.className = "declared-icon";
    mark.innerHTML = icon(entry.icon);
    el.append(mark);
  }
  el.append(document.createTextNode(entry.label));
}

/** Writes a button element: its content, its enabled state, its key, and its command. A button has no path or role. */
function paintButton(control, element, bind) {
  control.type = "button";
  control.className = "declared-button";
  paintContent(control, element);
  control.disabled = element.enabled === false;
  control.dataset.key = element.key;
  control.dataset.expose = CONTROL_NAME;
  connect(control, element.command, paramsOf(element), bind);
}

/** Writes the content of a label. A button label also takes its command and its disabled state. */
function paintLabel(label, entry, { key, path, bind }) {
  label.className = "declared-label";
  paintContent(label, entry);
  if (label.tagName !== "BUTTON") return;
  label.type = "button";
  label.dataset.key = key;
  label.dataset.path = JSON.stringify(path);
  label.dataset.role = "label";
  label.dataset.expose = CONTROL_NAME;
  label.disabled = entry.enabled === false;
  connect(label, entry.command, paramsOf(entry), bind);
}

/** The label element of an entry: a button when the entry has a command, otherwise a static span. */
const labelElement = (entry) => document.createElement(Object.hasOwn(entry, "command") ? "button" : "span");

function paintDetail(row, text) {
  if (text === undefined) {
    const old = childOf(row, "declared-detail");
    if (old) old.remove();
    return;
  }
  let detail = childOf(row, "declared-detail");
  if (!detail) {
    detail = document.createElement("span");
    detail.className = "declared-detail";
    row.append(detail);
  }
  detail.textContent = text;
}

function createItemRow(item) {
  const row = document.createElement("div");
  row.className = "declared-row";
  row.append(labelElement(item));
  return row;
}

function paintItem(row, item, listKey, bind) {
  if (item.selected === true) row.dataset.selected = "true";
  else delete row.dataset.selected;
  paintLabel(childWithout(row, ["declared-detail"]), item, { key: listKey, path: [item.key], bind });
  paintDetail(row, Object.hasOwn(item, "detail") ? item.detail : undefined);
}

function createNode(node) {
  const wrap = document.createElement("div");
  wrap.className = "declared-node";
  const row = document.createElement("div");
  row.className = "declared-row";
  row.append(labelElement(node));
  wrap.append(row);
  return wrap;
}

/** The expand control of a branch. It requests the state opposite to the one the branch shows. */
function paintExpand(control, { statusId, tree, path, expanded, bind }) {
  control.type = "button";
  control.className = "declared-expand";
  control.dataset.key = tree;
  control.dataset.path = JSON.stringify(path);
  control.dataset.role = "expand";
  control.dataset.expose = CONTROL_NAME;
  const mark = document.createElement("span");
  mark.className = "declared-icon";
  mark.innerHTML = icon(expanded ? "chevron-down" : "chevron-right");
  control.replaceChildren(mark);
  connect(control, EXPAND, { status: statusId, tree, path, expanded: !expanded }, bind);
}

/** The kept expanded state of the branch at path, which every branch of a drawn tree has. */
function keptOf(kept, tree, path) {
  const expanded = kept.get(tree)?.get(JSON.stringify(path));
  if (expanded === undefined) throw new Error(`tree ${tree} path ${JSON.stringify(path)} has no kept state`);
  return expanded;
}

/** Writes one tree node: its row with the expand control of a branch and its label, and the children of an expanded branch. */
function paintNode(wrap, node, path, ctx) {
  const row = wrap.firstElementChild;
  if (node.selected === true) row.dataset.selected = "true";
  else delete row.dataset.selected;
  const branch = isBranch(node);
  const expanded = branch ? keptOf(ctx.kept, ctx.tree, path) : false;
  let control = childOf(row, "declared-expand");
  if (branch) {
    if (!control) {
      control = document.createElement("button");
      row.prepend(control);
    }
    paintExpand(control, { statusId: ctx.statusId, tree: ctx.tree, path, expanded, bind: ctx.bind });
  } else if (control) {
    control.remove();
  }
  paintLabel(childWithout(row, ["declared-expand", "declared-detail"]), node, { key: ctx.tree, path, bind: ctx.bind });
  paintDetail(row, Object.hasOwn(node, "detail") ? node.detail : undefined);
  let children = childOf(wrap, "declared-children");
  if (branch && expanded) {
    if (!children) {
      children = document.createElement("div");
      children.className = "declared-children";
      wrap.append(children);
    }
    drawList(children, node.children, {
      key: entryKey,
      create: createNode,
      update: (child, entry) => paintNode(child, entry, [...path, entry.key], ctx),
    });
  } else if (children) {
    children.remove();
  }
}

function appendEmpty(box, text) {
  const empty = document.createElement("span");
  empty.className = "declared-empty";
  empty.append(document.createTextNode(text));
  box.append(empty);
}

/** Writes one root element into its box. Rows and nodes keep their elements while their keys stay (drawList of plugin-api). */
function paintRoot(box, element, ctx) {
  if (element.kind === "button") {
    paintButton(box, element, ctx.bind);
    return;
  }
  if (element.kind === "status-line") {
    box.className = "declared-status-line";
    box.textContent = element.text;
    return;
  }
  if (element.kind === "list") {
    box.className = "declared-list";
    drawList(box, element.items, {
      key: entryKey,
      create: createItemRow,
      update: (row, item) => paintItem(row, item, element.key, ctx.bind),
    });
    if (element.items.length === 0) appendEmpty(box, element.empty);
    return;
  }
  box.className = "declared-tree";
  drawList(box, element.nodes, {
    key: entryKey,
    create: createNode,
    update: (wrap, node) => paintNode(wrap, node, [node.key], { ...ctx, tree: element.key }),
  });
  if (element.nodes.length === 0) appendEmpty(box, element.empty);
}

/**
 * Draws the root elements of an accepted value into body. A root element keeps its box while its kind and key stay, so a redraw
 * keeps every control whose address stays. Every control is connected through bind(element, name, params, options) of the binder,
 * and carries the dom name and the control attributes. kept holds the expanded state of each tree by its key and the path of each
 * branch (settle).
 */
export function drawValue(body, elements, { statusId, bind, kept }) {
  for (const element of elements) {
    if (!["list", "tree", "button", "status-line"].includes(element.kind)) throw new Error(`declared UI kind ${element.kind} is not drawn yet`);
  }
  drawList(body, elements, {
    key: (element) => `${element.kind} ${element.key}`,
    create: (element) => document.createElement(element.kind === "button" ? "button" : "div"),
    update: (box, element) => paintRoot(box, element, { statusId, bind, kept }),
  });
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
          // default: without a baseline, a branch with no kept state is new and takes its plugin value (docs/spec/declared-ui.md, status mapping).
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
