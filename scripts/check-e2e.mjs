// Checks that window checks use neither arbitrary code execution nor the former observation channels.
//
// Window checks use only the declared entries of the local endpoint (status, command, dom) and native input.
// There is no way to send code to a document and run it, and a check that writes such a call is rejected.
// State is awaited through status.watch notifications. Waits of a fixed duration and repeated queries are
// rejected. setTimeout may be used only as the upper bound of a wait (the wait is rejected when the time passes),
// or to record an observation through report (the record never settles the wait). The timer rule does not apply to
// the tests of the harness: they run on mocked time, and their timers simulate the input of a request.
// A timeout may reject through local helper calls and their attached Promise completion callbacks.
// Checks every .mjs file under e2e and the window check harness (packages/window-check) (node_modules excluded).
//
//   node scripts/check-e2e.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "acorn";

const ROOT = new URL("../", import.meta.url).pathname;
const DIRS = [join(ROOT, "e2e"), join(ROOT, "packages", "window-check")];
const TYPESCRIPT_PACKAGE = createRequire(join(ROOT, "packages", "soksak", "package.json"))
  .resolve("typescript/package.json");
const TYPESCRIPT_TSC = join(resolve(TYPESCRIPT_PACKAGE, ".."), "bin", "tsc");
const ACTIVATION_ROOT = join(ROOT, "e2e", "activation");

const RULES = [
  { what: "eval", pattern: /\beval(Async)?\b/ },
  { what: "Function constructor", pattern: /\bnew\s+Function\s*\(/ },
  { what: "native probe", pattern: /\bnativeProbe\b|["'`]native ["'`]\s*\+/ },
  { what: "TCP control port", pattern: /\b4973[1-3]\b|node:net/ },
  { what: "a repeating timer", pattern: /\bsetInterval\s*\(/ },
  { what: "a fixed sleep", pattern: /\b(sleep|delay|pause)\s*\(|timers\/promises/, inputPacing: true },
  { what: "application activation that takes user focus", pattern: /\bactivate\s*:\s*true\b/, activationTier: true },
  // The cleanup of a window check goes into session.cleanup. When the cleanup of open fails, a t.after registered after it does not run,
  // so a server or process remains and the check process does not end. The cleanup of a session runs every step even when one fails.
  { what: "t.after for cleanup; register it with session.cleanup", pattern: /\bt\.after\s*\(/, sessionCleanup: true },
  // A window check does not read source paths of other components and receives values through declared status entries.
  { what: "a source path of another repository component", pattern: /(["'`/]|\.\.\/)(packages|plugins|sidecars|native|apps)\// },
];

// The checks of e2e/activation and e2e/real run only in runs the user approved and may activate the app.
const ACTIVATION_DIRS = ["e2e/activation/", "e2e/real/"];
// The real input tool leaves an interval between HID events at the speed of a human movement. It is not a wait for state, and
// the window server coalesces drag events sent without an interval. A fixed wait is not allowed outside this file.
const INPUT_PACING_FILE = "e2e/real/hid.mjs";
// app.mjs of the harness, which creates sessions, and unit checks that are not window checks use t.after.
const SESSION_CLEANUP_EXEMPT = ["packages/window-check/app.mjs", "packages/window-check/test/", "e2e/test/"];

/* A timeout rejects its Promise directly or forwards that Promise's reject callback to one local helper. */
function isFunction(node) {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression" || node?.type === "FunctionDeclaration";
}

function visit(node, ancestors, callback) {
  if (!node || typeof node !== "object" || typeof node.type !== "string") return;
  const path = [...ancestors, node];
  callback(node, path);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, path, callback);
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      visit(value, path, callback);
    }
  }
}

function identifier(node) {
  return node?.type === "Identifier" ? node.name : null;
}

function bindingNames(pattern, names) {
  if (!pattern) return;
  if (pattern.type === "Identifier") names.add(pattern.name);
  else if (pattern.type === "RestElement") bindingNames(pattern.argument, names);
  else if (pattern.type === "AssignmentPattern") bindingNames(pattern.left, names);
  else if (pattern.type === "ArrayPattern") pattern.elements.forEach((item) => bindingNames(item, names));
  else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) bindingNames(property.type === "RestElement" ? property.argument : property.value, names);
  }
}

function functionBindings(fn) {
  const names = new Set();
  fn.params.forEach((parameter) => bindingNames(parameter, names));
  const collect = (node) => {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;
    if (isFunction(node)) {
      if (node !== fn && node.type === "FunctionDeclaration") bindingNames(node.id, names);
      return;
    }
    if (node.type === "VariableDeclarator") bindingNames(node.id, names);
    if (node.type === "ClassDeclaration") bindingNames(node.id, names);
    if (node.type === "CatchClause") bindingNames(node.param, names);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object" && typeof value.type === "string") collect(value);
    }
  };
  collect(fn.body);
  return names;
}

function promiseExecutor(ancestors) {
  for (let index = ancestors.length - 2; index >= 1; index--) {
    const executor = ancestors[index];
    const parent = ancestors[index - 1];
    if (isFunction(executor) && parent?.type === "NewExpression" && identifier(parent.callee) === "Promise"
      && parent.arguments?.[0] === executor) {
      return executor;
    }
  }
  return null;
}

function localHelper(executor, name) {
  const matches = [];
  for (const statement of executor?.body?.body ?? []) {
    if (statement.type === "FunctionDeclaration" && identifier(statement.id) === name) matches.push(statement);
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (identifier(declaration.id) === name && isFunction(declaration.init)) matches.push(declaration.init);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function memberName(node) {
  return node?.type === "MemberExpression" && !node.computed ? identifier(node.property) : null;
}

function invokesEffect(node, executor, effectName, environment = new Map(), shadowed = new Set(), active = new Set(), depth = 0) {
  if (!node || depth > 8 || isFunction(node)) return false;
  if (node.type === "Identifier") {
    return false;
  }
  if (node.type === "CallExpression") {
    const calleeName = identifier(node.callee);
    const binding = environment.get(calleeName);
    if (binding && invokesCallback(binding.node, executor, effectName, binding.environment, binding.shadowed, active, depth + 1)) return true;
    if (calleeName === effectName && !shadowed.has(effectName)) return true;
    // Resolve only names that still refer to the executor's helper at this
    // call site. A callback-local binding with the same name takes precedence.
    const helper = shadowed.has(calleeName) ? null : localHelper(executor, calleeName);
    if (helper && !active.has(helper)) {
      const nextActive = new Set(active).add(helper);
      const helperEnvironment = new Map();
      helper.params.forEach((parameter, index) => {
        const name = identifier(parameter);
        const argument = node.arguments[index];
        if (name && argument) helperEnvironment.set(name, { node: argument, environment, shadowed });
      });
      // A helper closes over its definition scope. Caller-local bindings do
      // not shadow identifiers referenced inside the helper body; forwarded
      // arguments keep their caller scope in helperEnvironment above.
      const helperShadowed = functionBindings(helper);
      if (invokesEffect(helper.body, executor, effectName, helperEnvironment, helperShadowed, nextActive, depth + 1)) return true;
    }
    if (["then", "catch"].includes(memberName(node.callee))) {
      for (const argument of node.arguments) {
        if (invokesCallback(argument, executor, effectName, environment, shadowed, active, depth + 1)) return true;
      }
    }
    if (node.callee?.type === "MemberExpression"
      && invokesEffect(node.callee.object, executor, effectName, environment, shadowed, active, depth + 1)) return true;
    return node.arguments.some((argument) => !isFunction(argument)
      && invokesEffect(argument, executor, effectName, environment, shadowed, active, depth + 1));
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      if (value.some((child) => invokesEffect(child, executor, effectName, environment, shadowed, active, depth + 1))) return true;
    } else if (value && typeof value === "object" && typeof value.type === "string"
      && invokesEffect(value, executor, effectName, environment, shadowed, active, depth + 1)) {
      return true;
    }
  }
  return false;
}

function invokesCallback(node, executor, effectName, environment, shadowed, active, depth) {
  if (node?.type === "Identifier") {
    const binding = environment.get(node.name);
    if (binding) return invokesCallback(binding.node, executor, effectName, binding.environment, binding.shadowed, active, depth + 1);
    return node.name === effectName && !shadowed.has(effectName);
  }
  if (node?.type === "FunctionExpression" || node?.type === "ArrowFunctionExpression") {
    const callbackShadowed = new Set([...shadowed, ...functionBindings(node)]);
    return invokesEffect(node.body, executor, effectName, environment, callbackShadowed, active, depth + 1);
  }
  return invokesEffect(node, executor, effectName, environment, shadowed, active, depth + 1);
}

function timeoutRejects(callback, executor) {
  const rejectName = identifier(executor?.params?.[1]);
  return Boolean(rejectName && callback && invokesEffect(callback.body, executor, rejectName, new Map(), functionBindings(callback)));
}

function timeoutReports(callback, executor) {
  return Boolean(callback && invokesEffect(callback.body, executor, "report", new Map(), functionBindings(callback)));
}

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (name.endsWith(".mjs")) yield path;
  }
}

export function auditActivationUnboundNames(paths = [...sources(ACTIVATION_ROOT)]) {
  // Activation fixtures can send OS input; catch lexical name mistakes without
  // imposing the unrelated type and import diagnostics of a JavaScript project.
  const sourceNames = new Map(paths.map((path) => [resolve(ROOT, relative(ROOT, path)), relative(ROOT, path)]));
  if (sourceNames.size === 0) throw new Error("TypeScript unbound-name check received no activation sources");
  const result = spawnSync(process.execPath, [TYPESCRIPT_TSC,
    "--allowJs", "--checkJs", "--noEmit", "--noResolve", "--target", "ESNext",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck", "--pretty", "false",
    ...[...sourceNames.keys()].map((path) => relative(ROOT, path))], { cwd: ROOT, encoding: "utf8" });
  if (result.error) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.signal || result.status === null) {
    throw new Error(`TypeScript unbound-name check did not finish: ${result.signal ?? output.trim()}`);
  }
  const diagnostics = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.*)\((\d+),(\d+)\): error TS(2304|18004|2552): (.*)$/.exec(line);
    if (!match) continue;
    const name = sourceNames.get(resolve(ROOT, match[1]));
    if (name) diagnostics.push(`${name}:${match[2]}: ${match[5]}`);
  }
  if (result.status !== 0) {
    const unexpected = output.split(/\r?\n/).find((line) => line.trim()
      && !/^(?:.*\(\d+,\d+\): )?error TS\d+:/.test(line)
      && !/^ {2}\S/.test(line)
      && !/^Found \d+ errors? in \d+ files?\.?$/.test(line));
    if (unexpected) {
      throw new Error(`TypeScript unbound-name check could not analyze activation sources: ${unexpected}`);
    }
  }
  return diagnostics;
}

export function auditE2ESource(text, file) {
  const errors = [];
  text.split("\n").forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.activationTier && ACTIVATION_DIRS.some((dir) => file.startsWith(dir))) continue;
      if (rule.inputPacing && file === INPUT_PACING_FILE) continue;
      if (rule.sessionCleanup && SESSION_CLEANUP_EXEMPT.some((exempt) => file === exempt || file.startsWith(exempt))) continue;
      if (rule.pattern.test(line)) errors.push(`${file}:${index + 1}: uses ${rule.what}`);
    }
  });
  const harnessTest = file.startsWith(join("packages", "window-check", "test") + sep);
  if (!harnessTest) {
    let source;
    try {
      source = parse(text, { ecmaVersion: "latest", sourceType: "module", locations: true });
    } catch (error) {
      const line = Number.isInteger(error.loc?.line) ? error.loc.line : 1;
      errors.push(`${file}:${line}: cannot parse JavaScript source: ${error.message}`);
      return errors;
    }
    visit(source, [], (node, ancestors) => {
      if (node.type !== "CallExpression" || identifier(node.callee) !== "setTimeout") return;
      const callback = node.arguments[0];
      const executor = promiseExecutor(ancestors);
      if (timeoutReports(callback) || timeoutRejects(callback, executor)) return;
      errors.push(`${file}:${node.loc.start.line}: uses setTimeout as a wait; a timeout must reject`);
    });
  }
  return errors;
}

const errors = [];
for (const path of DIRS.flatMap((dir) => [...sources(dir)])) {
  errors.push(...auditE2ESource(readFileSync(path, "utf8"), relative(ROOT, path)));
}
errors.push(...auditActivationUnboundNames());

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Window check sources use only the endpoint");
  }
}
