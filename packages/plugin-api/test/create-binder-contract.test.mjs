// Runs published createBinder steps against the core implementation; no SDK code is copied into a fake.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createBinder } from "../binder.js";

const CONTRACT = JSON.parse(readFileSync(new URL("../contract/create-binder.json", import.meta.url), "utf8"));
const EXPECTED_IDS = [
  "binder.bind.runs-declared-command",
  "binder.bind.refuses-undeclared-command",
  "binder.bind.reports-failed-run",
  "binder.delegate.dispatches-declared-controls",
  "binder.audit.reports-unbound-controls",
  "binder.run.runs-and-refuses",
];

function makeElement(document, elements, spec) {
  if (elements.has(spec.id)) return elements.get(spec.id);
  const element = document.createElement(spec.tag);
  element.dataset.id = spec.id;
  if (spec.expose) element.dataset.expose = spec.expose;
  if (spec.text) element.textContent = spec.text;
  elements.set(spec.id, element);
  if (spec.parent) elements.get(spec.parent).append(element);
  else document.body.append(element);
  return element;
}

function elementOutput(element) {
  if (!element) return null;
  const output = {};
  for (const key of ["command", "params", "value", "live"]) {
    if (key in element.dataset) output[key] = element.dataset[key];
  }
  return output;
}

export async function runCreateBinderCase(testCase) {
  const { window } = new JSDOM("<body></body>");
  const { document } = window;
  const elements = new Map();
  const calls = [];
  const failed = [];
  let changed = 0;
  const binder = createBinder((name, params, element) => {
    calls.push({ name, params: structuredClone(params), element: element?.dataset.id ?? null });
    return params?.fail ? Promise.reject(new Error("command failed")) : Promise.resolve("accepted");
  }, {
    check(name) {
      if (!["fixture.save", "fixture.set"].includes(name)) throw new Error(`command ${name} is not declared`);
    },
    changed() { changed++; },
  });
  const outputs = [];
  for (const step of testCase.steps) {
    let result = null;
    let error = null;
    try {
      if (step.element) {
        const element = makeElement(document, elements, step.element);
        if (step.element.parent) elements.get(step.element.parent).append(element);
      } else if (step.bind) {
        const input = step.bind;
        const element = makeElement(document, elements, input);
        binder.bind(element, input.command, input.params ?? {}, {
          ...(input.failed ? { failed: (reason) => failed.push(reason.message) } : {}),
        });
      } else if (step.mark) {
        const input = step.mark;
        const element = makeElement(document, elements, input);
        binder.mark(element, input.command, input.params, input.valueName);
        if (input.live) element.dataset.live = "";
      } else if (step.delegate) {
        binder.delegate(makeElement(document, elements, { ...step.delegate, tag: "div" }));
      } else if (step.event) {
        const input = step.event;
        const element = elements.get(input.id);
        assert.ok(element, `contract event targets missing element ${input.id}`);
        if (input.value !== undefined) element.value = input.value;
        element.dispatchEvent(new window.Event(input.type, { bubbles: true }));
      } else if (step.run) {
        result = await binder.run(step.run.command, step.run.params);
      } else if (step.audit) {
        result = binder.audit(elements.get(step.audit.id));
      } else if (step.dispose) {
        binder.dispose();
      } else {
        assert.fail();
      }
    } catch (reason) {
      error = reason.message;
    }
    await new Promise((resolve) => setImmediate(resolve));
    const target = step.element?.id ?? step.bind?.id ?? step.mark?.id ?? step.event?.id;
    outputs.push({
      calls: structuredClone(calls),
      changed,
      failed: [...failed],
      result,
      error,
      element: elementOutput(target ? elements.get(target) : null),
    });
  }
  window.close();
  return outputs;
}

test("createBinder publishes ordered cases for its consumer contract", () => {
  assert.deepEqual(CONTRACT.cases.map(({ id }) => id), EXPECTED_IDS);
});

for (const testCase of CONTRACT.cases) {
  test(`createBinder ${testCase.id} matches each ordered step`, async () => {
    const actual = await runCreateBinderCase(testCase);
    assert.deepEqual(actual, testCase.steps.map(({ output }) => output));
  });
}
