// The reader of a page-wire case. It answers the calls of the workbench page with the replies that a case records, in the order
// of the case, and delivers the notices of the case to the listeners of the page (docs/spec/cases/page-wire/README.md). The runtime
// module of the workbench tests selects it (test/runtime/index.js).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

/** The directory of the page-wire cases. This module lives in packages/workbench/test/runtime, four levels below the repository root. */
const CASE_DIRECTORY = new URL("../../../../docs/spec/cases/page-wire/", import.meta.url);

const VARIABLE = /^\$[a-z][a-z0-9-]*$/;
const STEP_KINDS = ["call", "reply", "notice", "listen"];
const TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];
const SOURCES = ["host", "page"];

// Collects the variable names that a value uses.
function variablesIn(value, names) {
  if (typeof value === "string" && VARIABLE.test(value)) names.add(value.slice(1));
  else if (Array.isArray(value)) for (const item of value) variablesIn(item, names);
  else if (value && typeof value === "object") for (const item of Object.values(value)) variablesIn(item, names);
  return names;
}

// The declared types of a variable, as a list.
const typesOf = (spec) => (Array.isArray(spec.type) ? spec.type : [spec.type]);

// Reports whether a JSON value has one of the declared types.
function hasType(value, types) {
  return types.some((type) => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "integer") return Number.isInteger(value);
    return typeof value === type;
  });
}

// Checks the form of a case; a case that does not have it is an error that names the file.
function checkCase(kase, name, file) {
  const fail = (reason) => {
    throw new Error(`${file}: ${reason}`);
  };
  if (!kase || typeof kase !== "object" || Array.isArray(kase)) fail("the case is not an object");
  if (kase.name !== name) fail("name does not match the file name");
  if (typeof kase.description !== "string" || kase.description === "") fail("description must be a non-empty string");
  if (typeof kase.replay !== "boolean") fail("replay must be true or false");
  if (kase.replay === false && (typeof kase.reason !== "string" || kase.reason === "")) fail("a case with replay false must give its reason");
  const variables = kase.variables ?? {};
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) fail("variables must be an object");
  for (const [variable, spec] of Object.entries(variables)) {
    if (!VARIABLE.test(`$${variable}`)) fail(`variable ${variable} must have the form a-z, digits and hyphens`);
    if (!spec || typeof spec !== "object" || !("example" in spec)) fail(`variable ${variable} must have an example`);
    if (!("type" in spec) || !typesOf(spec).every((type) => TYPES.includes(type))) fail(`variable ${variable} must have a type of ${TYPES.join(", ")}`);
    if ("source" in spec && !SOURCES.includes(spec.source)) fail(`variable ${variable} source must be host or page`);
    if (!hasType(spec.example, typesOf(spec))) fail(`variable ${variable} example is not of its type`);
  }
  const source = (variable) => variables[variable]?.source ?? "host";
  if (!Array.isArray(kase.steps)) fail("steps must be an array");
  const used = new Set();
  kase.steps.forEach((step, index) => {
    const where = `step ${index}`;
    const kinds = step && typeof step === "object" ? STEP_KINDS.filter((kind) => kind in step) : [];
    if (kinds.length !== 1 || Object.keys(step).length !== 1) fail(`${where} must have exactly one of call, reply, notice and listen`);
    if (kinds[0] === "call") {
      const { call } = step;
      if (!call || typeof call !== "object" || Array.isArray(call)) fail(`${where} call must be an object`);
      if (typeof call.name !== "string" || call.name === "") fail(`${where} call must name a host call`);
      const allowed = ["name", "payload", "cids"];
      for (const key of Object.keys(call)) if (!allowed.includes(key)) fail(`${where} call has the undeclared field ${key}`);
      for (const variable of variablesIn(call, new Set())) {
        if (Object.hasOwn(variables, variable) && source(variable) !== "page") fail(`${where} call uses the host variable $${variable}: a call holds only values that the page chooses`);
        used.add(variable);
      }
      if (index + 1 >= kase.steps.length || !("reply" in kase.steps[index + 1])) fail(`${where} call must be followed by its reply`);
    } else if (kinds[0] === "reply") {
      const { reply } = step;
      if (!reply || typeof reply !== "object" || Array.isArray(reply)) fail(`${where} reply must be an object`);
      if (index === 0 || !("call" in kase.steps[index - 1])) fail(`${where} reply must follow its call`);
      const keys = Object.keys(reply).filter((key) => key !== "held");
      if (keys.length !== 1 || !["result", "error"].includes(keys[0])) fail(`${where} reply must have exactly one of result and error`);
      if ("held" in reply && reply.held !== true) fail(`${where} held must be true when it is present`);
      if ("error" in reply && (typeof reply.error !== "string" || reply.error === "")) fail(`${where} error must be a non-empty string`);
      variablesIn(reply, used);
    } else if (kinds[0] === "listen") {
      const { listen } = step;
      if (!listen || typeof listen !== "object" || Array.isArray(listen)) fail(`${where} listen must be an object`);
      if (typeof listen.event !== "string" || listen.event === "") fail(`${where} listen must name an event`);
      for (const key of Object.keys(listen)) if (!["event", "error", "held"].includes(key)) fail(`${where} listen has the undeclared field ${key}`);
      if ("error" in listen && (typeof listen.error !== "string" || listen.error === "")) fail(`${where} error must be a non-empty string`);
      if ("held" in listen && listen.held !== true) fail(`${where} held must be true when it is present`);
    } else {
      const { notice } = step;
      if (!notice || typeof notice !== "object" || Array.isArray(notice)) fail(`${where} notice must be an object`);
      if (typeof notice.event !== "string" || notice.event === "") fail(`${where} notice must name an event`);
      for (const key of Object.keys(notice)) if (!["event", "payload"].includes(key)) fail(`${where} notice has the undeclared field ${key}`);
      variablesIn(notice, used);
    }
  });
  for (const variable of used) if (!Object.hasOwn(variables, variable)) fail(`variable $${variable} is not declared`);
}

/** Reads and checks one case by its name. */
function readCase(name) {
  const file = fileURLToPath(new URL(`${name}.json`, CASE_DIRECTORY));
  let kase;
  try {
    kase = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not a readable case: ${error.message}`);
  }
  checkCase(kase, name, file);
  return kase;
}

// The call as the page sends it on the wire: JSON values, and an absent payload or absent identifiers are absent fields.
function onTheWire(name, payload, cids) {
  const call = { name };
  if (payload !== undefined) call.payload = JSON.parse(JSON.stringify(payload));
  if (cids !== undefined) call.cids = JSON.parse(JSON.stringify(cids));
  return call;
}

/**
 * Opens the case of the name for the page. The returned host answers each call of the page with the reply of the next step of the case.
 *
 * calls holds each call that the page sent, in order, as {name, payload} and as {name, payload, cids} when the call carried identifiers; a
 * test compares it with the calls it expects. A call that differs from the next step of the case rejects with the difference and is kept
 * in the failures. A value of a call that names a page variable matches any value of the type of the variable; the first value binds the
 * variable, and each later use must equal it. A held reply settles when the test calls release. deliverNotice plays the next step, which
 * must be a notice, and calls each listener that the page registered for its event with its payload. A case without a listen step
 * answers each registration of the page at once; a case with a listen step answers each registration with the next step, which must be
 * the listen step of the event: it resolves with the unsubscribe, or it rejects with the error of the step, and a held step settles when the test calls release. unsubscribed
 * lists the events whose listener the page removed. finish throws when a failure
 * happened, when a step of the case was not played or when a held reply was not released.
 */
export function openPageWire(name) {
  const kase = readCase(name);
  const { steps } = kase;
  const variables = kase.variables ?? {};
  const calls = [];
  const failures = [];
  // The values that the page chose for the page variables, by name.
  const bound = new Map();
  // The listeners of the page, by event.
  const listeners = new Map();
  // The replies that the case holds until the test releases them, in the order of their calls.
  const held = [];
  // The index of the next step of the case.
  let cursor = 0;

  const fail = (message) => {
    const text = `${name}: ${message}`;
    failures.push(text);
    return new Error(text);
  };

  // Replaces each variable with the value the page bound for it, or with its example value.
  const substitute = (value) => {
    if (typeof value === "string" && VARIABLE.test(value)) {
      const variable = value.slice(1);
      return structuredClone(bound.has(variable) ? bound.get(variable) : variables[variable].example);
    }
    if (Array.isArray(value)) return value.map(substitute);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item)]));
    return value;
  };

  // Returns the first difference between the value that the case expects and the value that the page sent, or null. A page variable
  // matches a value of its type and binds it in binding; the bindings of a call that differs are not kept.
  const difference = (path, expected, sent, binding) => {
    if (typeof expected === "string" && VARIABLE.test(expected) && variables[expected.slice(1)]?.source === "page") {
      const variable = expected.slice(1);
      const spec = variables[variable];
      if (!hasType(sent, typesOf(spec))) return `${path}: ${JSON.stringify(sent)} is not of the type ${JSON.stringify(spec.type)} of $${variable}`;
      const earlier = binding.has(variable) ? binding.get(variable) : bound.get(variable);
      if (earlier !== undefined && !isDeepStrictEqual(earlier, sent)) return `${path}: $${variable} was ${JSON.stringify(earlier)}, the page sent ${JSON.stringify(sent)}`;
      binding.set(variable, sent);
      return null;
    }
    if (Array.isArray(expected)) {
      if (!Array.isArray(sent) || sent.length !== expected.length) return `${path}: the case expects ${JSON.stringify(expected)}, the page sent ${JSON.stringify(sent)}`;
      for (let index = 0; index < expected.length; index += 1) {
        const found = difference(`${path}[${index}]`, expected[index], sent[index], binding);
        if (found) return found;
      }
      return null;
    }
    if (expected && typeof expected === "object") {
      if (!sent || typeof sent !== "object" || Array.isArray(sent)) return `${path}: the case expects ${JSON.stringify(expected)}, the page sent ${JSON.stringify(sent)}`;
      for (const key of new Set([...Object.keys(expected), ...Object.keys(sent)])) {
        if (!Object.hasOwn(sent, key)) return `${path}.${key}: the page sent no field ${key}`;
        if (!Object.hasOwn(expected, key)) return `${path}.${key}: the page sent the field ${key}, which the case does not record`;
        const found = difference(`${path}.${key}`, expected[key], sent[key], binding);
        if (found) return found;
      }
      return null;
    }
    return isDeepStrictEqual(expected, sent) ? null : `${path}: the case expects ${JSON.stringify(expected)}, the page sent ${JSON.stringify(sent)}`;
  };

  const call = (callName, payload, options) => {
    const sent = onTheWire(callName, payload, options?.cids);
    calls.push(sent);
    // PAGE_WIRE_TRACE=1 writes each call that the page sends, matched or not, so the author of a case reads the order of the page.
    if (process.env.PAGE_WIRE_TRACE === "1") process.stderr.write(`page-wire ${name} step ${cursor}: ${JSON.stringify(sent)}\n`);
    const step = steps[cursor];
    if (!step) return Promise.reject(fail(`the page called ${JSON.stringify(sent)} after the last step of the case`));
    if (!("call" in step)) return Promise.reject(fail(`the page called ${JSON.stringify(sent)} where the case has ${JSON.stringify(step)}`));
    const binding = new Map();
    const found = difference("call", onTheWire(step.call.name, step.call.payload, step.call.cids), sent, binding);
    if (found) return Promise.reject(fail(`step ${cursor}: ${found}`));
    for (const [variable, value] of binding) bound.set(variable, value);
    const { reply } = steps[cursor + 1];
    cursor += 2;
    const settle = (resolve, reject) => ("error" in reply ? reject(new Error(reply.error)) : resolve(substitute(reply.result)));
    if (reply.held) return new Promise((resolve, reject) => held.push(() => settle(resolve, reject)));
    return new Promise(settle);
  };

  // A case that records a registration of a listener records every registration of the page.
  const recordsListeners = steps.some((step) => "listen" in step);

  // The events whose listener the page removed, in the order of the removals.
  const unsubscribed = [];

  const on = (event, listener) => {
    if (process.env.PAGE_WIRE_TRACE === "1") process.stderr.write(`page-wire ${name} step ${cursor}: listen ${JSON.stringify(event)}\n`);
    const register = () => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return () => {
        listeners.get(event).delete(listener);
        unsubscribed.push(event);
      };
    };
    if (!recordsListeners) return Promise.resolve(register());
    const step = steps[cursor];
    if (!step) return Promise.reject(fail(`the page registered a listener of ${JSON.stringify(event)} after the last step of the case`));
    if (!("listen" in step)) return Promise.reject(fail(`the page registered a listener of ${JSON.stringify(event)} where the case has ${JSON.stringify(step)}`));
    if (step.listen.event !== event) return Promise.reject(fail(`step ${cursor}: the case expects a listener of ${JSON.stringify(step.listen.event)}, the page registered ${JSON.stringify(event)}`));
    cursor += 1;
    const { listen } = step;
    const settle = (resolve, reject) => ("error" in listen ? reject(new Error(listen.error)) : resolve(register()));
    if (listen.held) return new Promise((resolve, reject) => held.push(() => settle(resolve, reject)));
    return new Promise(settle);
  };

  return {
    call,
    on,
    calls,
    unsubscribed,
    /** Settles the oldest held reply or held registration. */
    release() {
      const next = held.shift();
      if (!next) throw fail("release found no held reply");
      next();
    },
    /** Plays the next step, which must be a notice, by calling each listener of its event with its payload. */
    deliverNotice() {
      const step = steps[cursor];
      if (!step || !("notice" in step)) throw fail(`deliverNotice found ${step ? JSON.stringify(step) : "no further step"} at step ${cursor}`);
      const { event } = step.notice;
      const registered = [...(listeners.get(event) ?? [])];
      if (registered.length === 0) throw fail(`step ${cursor}: the page has no listener of the notice ${event}`);
      cursor += 1;
      for (const listener of registered) listener(substitute(step.notice.payload));
    },
    finish() {
      const problems = [...failures];
      const left = steps.length - cursor;
      if (left > 0) problems.push(`${name}: ${left} steps of the case were not played, starting with ${JSON.stringify(steps[cursor])}`);
      if (held.length > 0) problems.push(`${name}: ${held.length} held replies were not released`);
      if (problems.length > 0) throw new Error(problems.join("\n"));
    },
  };
}
