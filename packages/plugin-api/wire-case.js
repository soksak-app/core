// The reader of a wire case that the page-wire reader of the workbench tests and the openView function of the SDK testing module share:
// the check of the form of a case, the matching of the calls of a consumer with the steps of the case, the variables, the held replies
// and the end of the case (docs/spec/cases/page-wire/README.md, docs/spec/cases/view-wire/README.md).
// The module needs no DOM: the page-wire reader runs without jsdom.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const VARIABLE = /^\$[a-z][a-z0-9-]*$/;
const TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];
const SOURCES = ["host", "page"];

export const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Collects the variable names that a value uses.
function variablesIn(value, names) {
  if (typeof value === "string" && VARIABLE.test(value)) names.add(value.slice(1));
  else if (Array.isArray(value)) for (const item of value) variablesIn(item, names);
  else if (isObject(value)) for (const item of Object.values(value)) variablesIn(item, names);
  return names;
}

// The declared types of a variable, as a list.
const typesOf = (spec) => (Array.isArray(spec.type) ? spec.type : [spec.type]);

// Reports whether a JSON value has one of the declared types.
function hasType(value, types) {
  return types.some((type) => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return isObject(value);
    if (type === "integer") return Number.isInteger(value);
    return typeof value === type;
  });
}

/**
 * Checks the form of a case; a case that does not have it is an error that names the file. `shape` describes the wire of the reader:
 * `identity` and `params` are the members of a call that name it and hold its argument (`name` and `payload` for the page, `command` and
 * `params` for the view), `callLabel` says what a call names, `kinds` lists the kinds of step in the order that the error names them,
 * `noticeData` the member of a notice that holds its data, `header(kase, fail)` checks the members that only this wire has, and `others[kind](body, where,
 * fail, only)` checks each step kind that this wire has besides call, reply and notice.
 */
function checkCase(kase, name, file, shape) {
  const fail = (reason) => {
    throw new Error(`${file}: ${reason}`);
  };
  if (!isObject(kase)) fail("the case is not an object");
  if (kase.name !== name) fail("name does not match the file name");
  if (typeof kase.description !== "string" || kase.description === "") fail("description must be a non-empty string");
  shape.header(kase, fail);
  if (typeof kase.replay !== "boolean") fail("replay must be true or false");
  if (kase.replay === false && (typeof kase.reason !== "string" || kase.reason === "")) fail("a case with replay false must give its reason");
  // default: a case without variables uses no variable.
  const variables = kase.variables ?? {};
  if (!isObject(variables)) fail("variables must be an object");
  for (const [variable, spec] of Object.entries(variables)) {
    if (!VARIABLE.test(`$${variable}`)) fail(`variable ${variable} must have the form a-z, digits and hyphens`);
    if (!isObject(spec) || !("example" in spec)) fail(`variable ${variable} must have an example`);
    if (!("type" in spec) || !typesOf(spec).every((type) => TYPES.includes(type))) fail(`variable ${variable} must have a type of ${TYPES.join(", ")}`);
    if ("source" in spec && !SOURCES.includes(spec.source)) fail(`variable ${variable} source must be host or page`);
    if (!hasType(spec.example, typesOf(spec))) fail(`variable ${variable} example is not of its type`);
  }
  // default: a variable whose source the case does not state is a value of the host (docs/spec/cases/page-wire/README.md).
  const source = (variable) => variables[variable]?.source ?? "host";
  if (!Array.isArray(kase.steps)) fail("steps must be an array");
  const kindsText = `${shape.kinds.slice(0, -1).join(", ")} and ${shape.kinds.at(-1)}`;
  const used = new Set();
  kase.steps.forEach((step, index) => {
    const where = `step ${index}`;
    const kinds = isObject(step) ? shape.kinds.filter((kind) => kind in step) : [];
    if (kinds.length !== 1 || Object.keys(step).length !== 1) fail(`${where} must have exactly one of ${kindsText}`);
    const [kind] = kinds;
    const body = step[kind];
    if (!isObject(body)) fail(`${where} ${kind} must be an object`);
    const only = (allowed) => {
      for (const key of Object.keys(body)) if (!allowed.includes(key)) fail(`${where} ${kind} has the undeclared field ${key}`);
    };
    if (kind === "call") {
      if (typeof body[shape.identity] !== "string" || body[shape.identity] === "") fail(`${where} call must name ${shape.callLabel}`);
      only([shape.identity, shape.params, "cids"]);
      for (const variable of variablesIn(body, new Set())) {
        if (Object.hasOwn(variables, variable) && source(variable) !== "page") fail(`${where} call uses the host variable $${variable}: a call holds only values that the ${shape.subject} chooses`);
        used.add(variable);
      }
      if (index + 1 >= kase.steps.length || !("reply" in kase.steps[index + 1])) fail(`${where} call must be followed by its reply`);
    } else if (kind === "reply") {
      if (index === 0 || !("call" in kase.steps[index - 1])) fail(`${where} reply must follow its call`);
      const keys = Object.keys(body).filter((key) => key !== "held");
      if (keys.length !== 1 || !["result", "error"].includes(keys[0])) fail(`${where} reply must have exactly one of result and error`);
      if ("held" in body && body.held !== true) fail(`${where} held must be true when it is present`);
      if ("error" in body && (typeof body.error !== "string" || body.error === "")) fail(`${where} error must be a non-empty string`);
      variablesIn(body, used);
    } else if (kind === "notice") {
      if (typeof body.event !== "string" || body.event === "") fail(`${where} notice must name an event`);
      only(["event", shape.noticeData]);
      variablesIn(body, used);
    } else {
      shape.others[kind](body, where, fail, only);
      variablesIn(body, used);
    }
  });
  for (const variable of used) if (!Object.hasOwn(variables, variable)) fail(`variable $${variable} is not declared`);
}

/** Reads and checks one case by its name in the directory (a URL). */
export function readCase(directory, name, shape) {
  const file = fileURLToPath(new URL(`${name}.json`, directory));
  let kase;
  try {
    kase = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not a readable case: ${error.message}`);
  }
  checkCase(kase, name, file, shape);
  return kase;
}

/**
 * The state of the reader of one case: the matching of the calls of the consumer with the steps, the variables, the held replies and the
 * end of the case. `shape` is the shape of the reader (as for readCase) with `logName`, the name of the calls of the log stream.
 *
 * The calls of the log stream are matched in their own order among the log steps of the case, and every other call in its order among the
 * other steps; the page writes the log calls at instants that no other call determines. A value of a call that names a page variable
 * matches any value of the type of the variable; the first value binds the variable, and each later use must equal it.
 */
export function createWire(name, kase, shape) {
  const { steps } = kase;
  // default: a case without variables uses no variable.
  const variables = kase.variables ?? {};
  const { subject, identity, params } = shape;
  const failures = [];
  // The values that the consumer chose for the page variables, by name.
  const bound = new Map();
  // The replies and registrations that the case holds until the test releases them, in the order of their calls.
  const held = [];
  const isLogCall = (step) => Boolean(step) && "call" in step && step.call[identity] === shape.logName;
  const logCalls = steps.flatMap((step, index) => (isLogCall(step) ? [index] : []));
  // The number of the log steps that the consumer played, and the index of the next step that is not a step of the log stream.
  let logPlayed = 0;
  let cursor = 0;
  const skipLog = () => {
    while (isLogCall(steps[cursor])) cursor += 2;
  };
  skipLog();

  const fail = (message) => {
    const text = `${name}: ${message}`;
    failures.push(text);
    return new Error(text);
  };

  // Replaces each variable with the value the consumer bound for it, or with its example value.
  const substitute = (value) => {
    if (typeof value === "string" && VARIABLE.test(value)) {
      const variable = value.slice(1);
      return structuredClone(bound.has(variable) ? bound.get(variable) : variables[variable].example);
    }
    if (Array.isArray(value)) return value.map(substitute);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item)]));
    return value;
  };

  // Returns the first difference between the value that the case expects and the value that the consumer sent, or null. A page variable
  // matches a value of its type and binds it in binding; the bindings of a call that differs are not kept.
  const difference = (path, expected, sent, binding) => {
    if (typeof expected === "string" && VARIABLE.test(expected) && variables[expected.slice(1)]?.source === "page") {
      const variable = expected.slice(1);
      const spec = variables[variable];
      if (!hasType(sent, typesOf(spec))) return `${path}: ${JSON.stringify(sent)} is not of the type ${JSON.stringify(spec.type)} of $${variable}`;
      const earlier = binding.has(variable) ? binding.get(variable) : bound.get(variable);
      if (earlier !== undefined && !isDeepStrictEqual(earlier, sent)) return `${path}: $${variable} was ${JSON.stringify(earlier)}, the ${subject} sent ${JSON.stringify(sent)}`;
      binding.set(variable, sent);
      return null;
    }
    if (Array.isArray(expected)) {
      if (!Array.isArray(sent) || sent.length !== expected.length) return `${path}: the case expects ${JSON.stringify(expected)}, the ${subject} sent ${JSON.stringify(sent)}`;
      for (let index = 0; index < expected.length; index += 1) {
        const found = difference(`${path}[${index}]`, expected[index], sent[index], binding);
        if (found) return found;
      }
      return null;
    }
    if (isObject(expected)) {
      if (!isObject(sent)) return `${path}: the case expects ${JSON.stringify(expected)}, the ${subject} sent ${JSON.stringify(sent)}`;
      for (const key of new Set([...Object.keys(expected), ...Object.keys(sent)])) {
        if (!Object.hasOwn(sent, key)) return `${path}.${key}: the ${subject} sent no field ${key}`;
        if (!Object.hasOwn(expected, key)) return `${path}.${key}: the ${subject} sent the field ${key}, which the case does not record`;
        const found = difference(`${path}.${key}`, expected[key], sent[key], binding);
        if (found) return found;
      }
      return null;
    }
    return isDeepStrictEqual(expected, sent) ? null : `${path}: the case expects ${JSON.stringify(expected)}, the ${subject} sent ${JSON.stringify(sent)}`;
  };

  // The call as the consumer sends it on the wire: JSON values, and an absent argument or absent identifiers are absent fields.
  const onTheWire = (call) => {
    const sent = { [identity]: call[identity] };
    if (call[params] !== undefined) sent[params] = JSON.parse(JSON.stringify(call[params]));
    if (call.cids !== undefined) sent.cids = JSON.parse(JSON.stringify(call.cids));
    return sent;
  };

  // The environment variable PAGE_WIRE_TRACE=1 (VIEW_WIRE_TRACE=1 for the view) writes each call that the consumer sends, matched or not,
  // so the author of a case reads the order of the consumer.
  const tracing = process.env[`${subject.toUpperCase()}_WIRE_TRACE`] === "1";
  const trace = (text) => {
    if (tracing) process.stderr.write(`${subject}-wire ${name} ${text}\n`);
  };

  return {
    onTheWire,
    fail,
    substitute,
    trace,
    /** The index of the next step of the case that is not a step of the log stream, and that step. */
    get cursor() {
      return cursor;
    },
    peek: () => steps[cursor],
    /** Moves the cursor past the step that the consumer played, and past the log steps that follow it. */
    advance() {
      cursor += 1;
      skipLog();
    },
    /**
     * Matches the call `sent` (in its wire form) with the next step of its stream. Returns {reply, index} with the reply step and the
     * index of the call step, or {error} with the failure that was kept.
     */
    match(sent) {
      const isLog = sent[identity] === shape.logName;
      const index = isLog ? logCalls[logPlayed] : cursor;
      trace(`step ${index}: ${JSON.stringify(sent)}`);
      const step = steps[index];
      if (!step) return { error: fail(`the ${subject} called ${JSON.stringify(sent)} after the last ${isLog ? "log " : ""}step of the case`) };
      if (!("call" in step)) return { error: fail(`the ${subject} called ${JSON.stringify(sent)} where the case has ${JSON.stringify(step)}`) };
      const binding = new Map();
      const found = difference("call", onTheWire(step.call), sent, binding);
      if (found) return { error: fail(`step ${index}: ${found}`) };
      for (const [variable, value] of binding) bound.set(variable, value);
      if (isLog) logPlayed += 1;
      else {
        cursor += 2;
        skipLog();
      }
      return { reply: steps[index + 1].reply, index };
    },
    /** Keeps the settlement of a held reply or registration of the step `index` of the case; `heldName` is the name of its call or event. */
    hold(index, heldName, settle) {
      held.push({ index, name: heldName, settle });
    },
    /**
     * Settles a held entry. Without `key` it is the oldest; a number is the index of the step of the case (the call step of a reply, the
     * listen step of a registration) that holds it, and a string is the name of the call or of the event, which settles the oldest
     * entry of that name. An entry that the key does not name is a failure.
     */
    release(key) {
      const position = key === undefined ? (held.length > 0 ? 0 : -1)
        : held.findIndex((entry) => (typeof key === "number" ? entry.index === key : entry.name === key));
      if (position < 0) throw fail(key === undefined ? "release found no held reply" : `release found no held reply of ${typeof key === "number" ? `step ${key}` : JSON.stringify(key)}`);
      const [entry] = held.splice(position, 1);
      entry.settle();
    },
    /** Throws when a failure was kept, when a step of the case was not played (of either stream) or when a held reply was not released. */
    finish() {
      const problems = [...failures];
      const left = steps.length - cursor;
      if (left > 0) problems.push(`${name}: ${left} steps of the case were not played, starting with ${JSON.stringify(steps[cursor])}`);
      const logLeft = logCalls.length - logPlayed;
      if (logLeft > 0) problems.push(`${name}: ${logLeft} log steps of the case were not played, starting with ${JSON.stringify(steps[logCalls[logPlayed]])}`);
      if (held.length > 0) problems.push(`${name}: ${held.length} held replies were not released`);
      if (problems.length > 0) throw new Error(problems.join("\n"));
    },
  };
}
