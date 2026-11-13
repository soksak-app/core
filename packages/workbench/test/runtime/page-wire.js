// The reader of a page-wire case. It answers the calls of the workbench page with the replies that a case records, in the order
// of the case (docs/spec/cases/page-wire/README.md). The runtime module of the workbench tests selects it (test/runtime/index.js).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

/** The directory of the page-wire cases. This module lives in packages/workbench/test/runtime, four levels below the repository root. */
const CASE_DIRECTORY = new URL("../../../../docs/spec/cases/page-wire/", import.meta.url);

const VARIABLE = /^\$[a-z][a-z0-9-]*$/;
const STEP_KINDS = ["call", "reply"];

// Collects the variable names that a value uses.
function variablesIn(value, names) {
  if (typeof value === "string" && VARIABLE.test(value)) names.add(value.slice(1));
  else if (Array.isArray(value)) for (const item of value) variablesIn(item, names);
  else if (value && typeof value === "object") for (const item of Object.values(value)) variablesIn(item, names);
  return names;
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
    if (!("type" in spec)) fail(`variable ${variable} must have a type`);
  }
  if (!Array.isArray(kase.steps)) fail("steps must be an array");
  const used = new Set();
  kase.steps.forEach((step, index) => {
    const where = `step ${index}`;
    const kinds = step && typeof step === "object" ? STEP_KINDS.filter((kind) => kind in step) : [];
    if (kinds.length !== 1 || Object.keys(step).length !== 1) fail(`${where} must have exactly one of call and reply`);
    if (kinds[0] === "call") {
      const { call } = step;
      if (!call || typeof call !== "object" || Array.isArray(call)) fail(`${where} call must be an object`);
      if (typeof call.name !== "string" || call.name === "") fail(`${where} call must name a host call`);
      const allowed = ["name", "payload", "cids"];
      for (const key of Object.keys(call)) if (!allowed.includes(key)) fail(`${where} call has the undeclared field ${key}`);
      if (variablesIn(call, new Set()).size > 0) fail(`${where} call must not use variables: the page sends the values it chooses`);
      if (index + 1 >= kase.steps.length || !("reply" in kase.steps[index + 1])) fail(`${where} call must be followed by its reply`);
    } else {
      const { reply } = step;
      if (!reply || typeof reply !== "object" || Array.isArray(reply)) fail(`${where} reply must be an object`);
      if (index === 0 || !("call" in kase.steps[index - 1])) fail(`${where} reply must follow its call`);
      const keys = Object.keys(reply);
      if (keys.length !== 1 || !["result", "error"].includes(keys[0])) fail(`${where} reply must have exactly one of result and error`);
      if ("error" in reply && (typeof reply.error !== "string" || reply.error === "")) fail(`${where} error must be a non-empty string`);
      variablesIn(reply, used);
    }
  });
  if (kase.steps.length > 0 && !("reply" in kase.steps[kase.steps.length - 1])) fail("the case must end with a reply");
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
 * in the failures; finish throws when a failure happened or when a step of the case was not played. A case has no notices: the listeners
 * of the page are never called (on registers a listener and returns its unsubscribe function).
 */
export function openPageWire(name) {
  const kase = readCase(name);
  const { steps } = kase;
  const variables = kase.variables ?? {};
  const calls = [];
  const failures = [];
  // The index of the next step of the case.
  let cursor = 0;

  const fail = (message) => {
    const text = `${name}: ${message}`;
    failures.push(text);
    return new Error(text);
  };

  // Replaces each variable with its example value. A variable names a value that the host chooses in the application.
  const substitute = (value) => {
    if (typeof value === "string" && VARIABLE.test(value)) return structuredClone(variables[value.slice(1)].example);
    if (Array.isArray(value)) return value.map(substitute);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item)]));
    return value;
  };

  const call = (callName, payload, options) => {
    const sent = onTheWire(callName, payload, options?.cids);
    calls.push(sent);
    const step = steps[cursor];
    if (!step) return Promise.reject(fail(`the page called ${JSON.stringify(sent)} after the last step of the case`));
    if (!("call" in step)) return Promise.reject(fail(`the page called ${JSON.stringify(sent)} where the case has ${JSON.stringify(step)}`));
    const expected = onTheWire(step.call.name, step.call.payload, step.call.cids);
    if (!isDeepStrictEqual(sent, expected)) {
      return Promise.reject(fail(`step ${cursor}: the page sent ${JSON.stringify(sent)}, the case expects ${JSON.stringify(expected)}`));
    }
    const reply = steps[cursor + 1].reply;
    cursor += 2;
    if ("error" in reply) return Promise.reject(new Error(reply.error));
    return Promise.resolve(substitute(reply.result));
  };

  return {
    call,
    on: () => Promise.resolve(() => {}),
    calls,
    finish() {
      const problems = [...failures];
      const left = steps.length - cursor;
      if (left > 0) problems.push(`${name}: ${left} steps of the case were not played, starting with ${JSON.stringify(steps[cursor])}`);
      if (problems.length > 0) throw new Error(problems.join("\n"));
    },
  };
}
