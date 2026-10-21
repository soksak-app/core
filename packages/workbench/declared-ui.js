// Declared UI values of a sidebar section (docs/spec/declared-ui.md): the validator of a value, the drawing of its elements,
// and the display of a rejected value through showError and hideError. The validator collects every violation of a value and
// reports the one of the first row in the rejection table; within that row, the first occurrence in document order.
import { icon } from "./icons.js";
import { hideError, showError } from "./shown-errors.js";

/** The dom name of every control that a declared UI value draws (docs/spec/exposure.md). */
export const CONTROL_NAME = "core.sidebar.section.control";

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

function drawItem(listKey, item, bind) {
  const row = document.createElement("div");
  row.className = "declared-row";
  if (item.selected === true) row.dataset.selected = "true";
  let label;
  if (Object.hasOwn(item, "command")) {
    label = document.createElement("button");
    label.type = "button";
    label.dataset.key = listKey;
    label.dataset.path = JSON.stringify([item.key]);
    label.dataset.role = "label";
    label.dataset.expose = CONTROL_NAME;
    if (item.enabled === false) label.disabled = true;
    bind(label, item.command, item.params, { event: "click" });
  } else {
    label = document.createElement("span");
  }
  label.className = "declared-label";
  if (Object.hasOwn(item, "icon")) {
    const mark = document.createElement("span");
    mark.className = "declared-icon";
    mark.innerHTML = icon(item.icon);
    label.append(mark);
  }
  label.append(document.createTextNode(item.label));
  row.append(label);
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

/**
 * Draws the root elements of an accepted value into body, replacing its previous content. Every control is connected through
 * bind(element, name, params, options) of the binder, and carries the dom name and the control attributes.
 */
export function drawValue(body, elements, { bind }) {
  const nodes = elements.map((element) => {
    if (element.kind !== "list") throw new Error(`declared UI kind ${element.kind} is not drawn yet`);
    return drawList(element, bind);
  });
  body.replaceChildren(...nodes);
}

/**
 * Receives a declared UI value of one status into the section body. An accepted value is drawn and withdraws the error display of
 * the status. A rejected value removes the previous tree and shows the rejection through showError, which writes the log line.
 */
export function receive(body, value, options) {
  const where = `declared UI ${options.owner}.${options.status}`;
  let elements;
  try {
    ({ elements } = validateValue(value, options));
  } catch (error) {
    if (!(error instanceof DeclaredUIRejection)) throw error;
    body.replaceChildren();
    showError(body, where, `${error.pointer}: ${error.reason}`);
    return false;
  }
  drawValue(body, elements, options);
  hideError(body, where);
  return true;
}
