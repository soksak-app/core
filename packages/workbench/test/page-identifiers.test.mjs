// An inline script of a page has no importer, so no test runs it, and a name that it does not declare fails only when the
// page opens. This reads every script of the pages and every shipped module with a parser and resolves each name in its scope.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { parse } from "acorn";
import { JSDOM } from "jsdom";

/** The names of a binding pattern. */
function bindingNames(pattern) {
  switch (pattern?.type) {
    case "Identifier": return [pattern];
    case "ObjectPattern": return pattern.properties.flatMap((item) => bindingNames(item.type === "RestElement" ? item.argument : item.value));
    case "ArrayPattern": return pattern.elements.flatMap(bindingNames);
    case "AssignmentPattern": return bindingNames(pattern.left);
    case "RestElement": return bindingNames(pattern.argument);
    default: return [];
  }
}

const isFunction = (node) => ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type);
const children = (node) => Object.values(node).flatMap((value) => (Array.isArray(value) ? value : [value])).filter((value) => typeof value?.type === "string");

/** Adds the var declarations under node to the scope. They belong to the function, whatever block holds them. */
function hoistVars(node, scope) {
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    for (const { id } of node.declarations) for (const { name } of bindingNames(id)) scope.names.set(name, null);
  }
  for (const child of children(node)) if (!isFunction(child)) hoistVars(child, scope);
}

/** Adds the declarations of a statement list to its scope. A let, const or class holds the position before which its scope cannot read it. */
function declare(statements, scope) {
  for (const statement of statements) {
    const declared = statement.type.startsWith("Export") && statement.declaration ? statement.declaration : statement;
    if (declared.type === "ImportDeclaration") for (const { local } of declared.specifiers) scope.names.set(local.name, null);
    if (declared.type === "FunctionDeclaration" && declared.id) scope.names.set(declared.id.name, null);
    if (declared.type === "ClassDeclaration" && declared.id) scope.names.set(declared.id.name, declared.start);
    if (declared.type === "VariableDeclaration" && declared.kind !== "var") {
      for (const { id } of declared.declarations) for (const { name, start } of bindingNames(id)) scope.names.set(name, start);
    }
  }
}

/**
 * The failures of a script that ends in a ReferenceError: a name that no scope declares and that is no name of the page, and a
 * let, const or class that its own scope reads before the declaration, without a function between them. A read through a function
 * that runs before the declaration is not found.
 */
function unresolvedNames(source, known) {
  const found = [];
  const child = (parent, boundary = false) => ({ parent, boundary, names: new Map() });

  function read({ name, start }, scope) {
    let crossed = false;
    for (let at = scope; at; at = at.parent) {
      if (at.names.has(name)) {
        const declaredAt = at.names.get(name);
        if (!crossed && declaredAt !== null && start < declaredAt) found.push(`${name} before its declaration`);
        return;
      }
      crossed ||= at.boundary;
    }
    if (!known.has(name)) found.push(name);
  }

  function visitFunction(node, parent) {
    const scope = child(parent, true);
    if (node.type !== "ArrowFunctionExpression") scope.names.set("arguments", null);
    if (node.type === "FunctionExpression" && node.id) scope.names.set(node.id.name, null);
    for (const param of node.params) for (const { name } of bindingNames(param)) scope.names.set(name, null);
    node.params.forEach((param) => visit(param, scope));
    if (node.body.type !== "BlockStatement") return visit(node.body, scope);
    hoistVars(node.body, scope);
    declare(node.body.body, scope);
    node.body.body.forEach((statement) => visit(statement, scope));
  }

  function visit(node, scope) {
    if (!node) return;
    if (isFunction(node)) return visitFunction(node, scope);
    switch (node.type) {
      case "Identifier": return read(node, scope);
      case "ImportDeclaration": case "LabeledStatement": case "BreakStatement": case "ContinueStatement": case "MetaProperty":
        return node.type === "LabeledStatement" ? visit(node.body, scope) : undefined;
      case "ExportNamedDeclaration": return node.source ? undefined : node.declaration ? visit(node.declaration, scope) : node.specifiers.forEach(({ local }) => visit(local, scope));
      case "ExportAllDeclaration": return undefined;
      case "MemberExpression":
        visit(node.object, scope);
        return node.computed ? visit(node.property, scope) : undefined;
      case "UnaryExpression":
        // A typeof of an undeclared name is the one read that does not throw.
        return node.operator === "typeof" && node.argument.type === "Identifier" ? undefined : visit(node.argument, scope);
      case "Property": case "PropertyDefinition": case "MethodDefinition":
        if (node.computed) visit(node.key, scope);
        return visit(node.value, node.type === "PropertyDefinition" ? child(scope, true) : scope);
      case "ClassDeclaration": case "ClassExpression": {
        visit(node.superClass, scope);
        const inside = child(scope);
        if (node.id) inside.names.set(node.id.name, null);
        return node.body.body.forEach((member) => visit(member, inside));
      }
      case "BlockStatement": case "StaticBlock": {
        const inside = child(scope, node.type === "StaticBlock");
        declare(node.body, inside);
        return node.body.forEach((statement) => visit(statement, inside));
      }
      case "ForStatement": case "ForInStatement": case "ForOfStatement": {
        const inside = child(scope);
        const head = node.type === "ForStatement" ? node.init : node.left;
        if (head?.type === "VariableDeclaration") declare([head], inside);
        return children(node).forEach((item) => visit(item, inside));
      }
      case "SwitchStatement": {
        visit(node.discriminant, scope);
        const inside = child(scope);
        declare(node.cases.flatMap((item) => item.consequent), inside);
        return node.cases.forEach((item) => { visit(item.test, inside); item.consequent.forEach((statement) => visit(statement, inside)); });
      }
      case "CatchClause": {
        const inside = child(scope);
        for (const { name } of bindingNames(node.param)) inside.names.set(name, null);
        visit(node.param, inside);
        return visit(node.body, inside);
      }
      default:
        return children(node).forEach((item) => visit(item, scope));
    }
  }

  const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const top = child(null, true);
  hoistVars(program, top);
  declare(program.body, top);
  program.body.forEach((statement) => visit(statement, top));
  return found;
}

const url = (file) => new URL(`../${file}`, import.meta.url);
const text = (file) => readFileSync(url(file), "utf8");
/** The names that an object holds and inherits, as the global object of a page reads them. */
function namesOf(object) {
  const names = [];
  for (let at = object; at; at = Object.getPrototypeOf(at)) names.push(...Object.getOwnPropertyNames(at));
  return names;
}

// The names of a page: JavaScript, the browser that the window of the parser models, and the browser names that it leaves out.
const pageNames = new Set([
  ...namesOf(runInNewContext("globalThis")),
  ...namesOf(new JSDOM("", { pretendToBeVisual: true }).window),
  "ResizeObserver", "IntersectionObserver", "matchMedia", "structuredClone", "MessageChannel",
]);

test("the check finds a name that no scope declares, as a page finds it when it opens", () => {
  const names = (source) => unresolvedNames(source, new Set(["document"]));
  assert.deepEqual(names("function draw() { keep(into, []); } function keep() {}"), ["into"]);
  assert.deepEqual(names("export function draw() { return () => { if (true) { missing(); } }; }"), ["missing"]);
  assert.deepEqual(names("const value = { key: 1, shorthand };"), ["shorthand"]);
  assert.deepEqual(names("const { a = fallback } = document;"), ["fallback"]);
  assert.deepEqual(names("undeclared = 1;"), ["undeclared"]);
  assert.deepEqual(names("{ const inner = 1; } inner;"), ["inner"]);
  assert.deepEqual(names("class A extends Base { field = absent; }"), ["Base", "absent"]);
});

test("the check finds a let, const or class that its scope reads before the declaration", () => {
  const names = (source) => unresolvedNames(source, new Set());
  assert.deepEqual(names("late; const late = 1;"), ["late before its declaration"]);
  assert.deepEqual(names("new Later(); class Later {}"), ["Later before its declaration"]);
  assert.deepEqual(names("const read = () => late; const late = 1;"), []);
});

test("the check takes every declaration and every name that is no read", () => {
  const sources = [
    'import one, { two as three } from "./module.js"; import * as four from "./other.js"; one(three, four);',
    "early(); function early() { return arguments; }",
    "function f({ a, b: [c] }, ...rest) { return [a, c, rest]; } f();",
    "const f = function named() { return named; }; f();",
    "if (true) { var lifted = 1; } lifted;",
    "for (const item of []) item; for (let i = 0; i < 1; i++) i; for (const key in {}) key;",
    "try { throw 1; } catch ({ message }) { message; }",
    "switch (1) { case 1: const a = 1; a; }",
    "const value = typeof absent; value;",
    "const object = { key: 1, method() {} }; object.key; object.other; outer: for (;;) { break outer; }",
    "class C { static s = C; field = 1; method() { return C; } } new C();",
    "export const a = 1; export { a as b };",
  ];
  for (const source of sources) assert.deepEqual(unresolvedNames(source, new Set()), [], source);
});

for (const page of ["index.html", "overlay.html"]) {
  test(`every inline script of ${page} declares the names that it reads`, () => {
    const { document } = new JSDOM(text(page)).window;
    const scripts = [...document.querySelectorAll("script:not([src]):not([type=importmap])")];
    assert.ok(scripts.length > 0, `${page} has no inline script`);
    for (const script of scripts) assert.deepEqual(unresolvedNames(script.textContent, pageNames), [], page);
  });
}

test("every shipped module declares the names that it reads", () => {
  const modules = JSON.parse(text("package.json")).files.filter((name) => name.endsWith(".js"));
  assert.ok(modules.includes("bar-tabs.js"));
  const failures = Object.fromEntries(modules.map((file) => [file, unresolvedNames(text(file), pageNames)]).filter(([, names]) => names.length));
  assert.deepEqual(failures, {});
});
