// The view of the input probe: a text field of the view document and a native document region whose document holds a text
// field. Each field reports the keys it receives, the preedit of the input method, its commits, its caret and the text of
// Edit > Copy and Edit > Paste through a status, and the view forwards Escape to `core.picker.close` while a picker is open, as a
// view without its own Escape action does (docs/spec/plugin-processes.md#rules, rule 7). The fixture carries the input checks
// of core without a real plugin (docs/spec/plugin-processes.md#verification-boundaries).
import { createBinder, createExpose } from "@soksak/plugin-api";
import { createViewBridge, createViewReporter } from "@soksak/plugin-api/view";
import { createInputLog } from "./input-log.js";

const PLUGIN = "probeinput";
const PAGE = `soksak://${PLUGIN}/ui/field.html`;
const TARGETS = ["field", "document"];

const bridge = createViewBridge({
  handler: window.webkit.messageHandlers["sok-view"],
  report: createViewReporter({ reportError: window.reportError.bind(window), console: window.console }),
});
const expose = createExpose({
  register: bridge.exposure.register, reply: bridge.exposure.reply, changed: bridge.exposure.changed,
  report: (text) => bridge.runtime.error("probeinput exposure", text),
  onRequest: (answer) => bridge.runtime.native.on("exposure-request", answer),
}, () => window.sokSurface.declarations);

/** A status value with its listeners: read() is the value, set(value) replaces it and calls each listener. */
function statusValue(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    read: () => value,
    set(next) {
      value = next;
      for (const listener of listeners) listener(value);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const fieldElement = document.getElementById("field");
const field = createInputLog(fieldElement, window);
// The state of the region document is the state of its last message; ready is false until the document sent one.
const regionState = statusValue({ ready: false, documentTimeOriginMs: 0, focused: false, value: "", caret: { start: 0, end: 0, direction: "none" },
  preedit: null, keys: [], commits: [], copies: [], pastes: [], wheels: [], pointer: { downs: 0, drags: 0, ups: 0, foreign: 0 } });
const routing = statusValue({ pickerOpen: false, forwarded: [] });

// Escape forwarding: a key down of Escape that is not part of a composition runs core.picker.close while a picker is open. Each
// target keeps the sequence of the last key it examined, so a key is examined once although each change carries the whole log.
let forwardSequence = 0;
const examined = { field: 0, document: 0 };
const forwardKeys = (target, keys) => {
  for (const key of keys) {
    if (key.sequence <= examined[target]) continue;
    examined[target] = key.sequence;
    if (key.type !== "keydown" || key.key !== "Escape" || key.composing || !routing.read().pickerOpen) continue;
    const entry = { sequence: ++forwardSequence, target, keySequence: key.sequence, command: "core.picker.close", error: null };
    bridge.runtime.command("core.picker.close", {}).then(
      () => record(entry),
      // default: a refusal that is not an Error carries its value as the text.
      (error) => record({ ...entry, error: String(error?.message ?? error) }));
  }
};
const record = (entry) => {
  const { pickerOpen, forwarded } = routing.read();
  routing.set({ pickerOpen, forwarded: [...forwarded, entry].slice(-256) });
};
field.subscribe((state) => forwardKeys("field", state.keys));
bridge.runtime.status.watch("core.picker", (picker) => {
  routing.set({ ...routing.read(), pickerOpen: picker?.open === true });
});

const composition = await bridge.composition.create({ regions: { text: document.getElementById("text") }, overlays: {} });
const region = composition.region("text");
// The requests to the region document wait for its reply by id.
let requestId = 0;
const pending = new Map();
region.onMessage((message) => {
  if (message?.probeinput === "state" || message?.probeinput === "reply") {
    regionState.set({ ready: true, ...message.state });
    forwardKeys("document", message.state.keys);
  }
  if (message?.probeinput !== "reply") return;
  const waiting = pending.get(message.id);
  if (waiting === undefined) return;
  pending.delete(message.id);
  if (message.error !== undefined) waiting.reject(new Error(`input probe document ${message.error}`));
  else waiting.resolve(message.result);
});
const requestDocument = (action, params) => {
  if (!regionState.read().ready) return Promise.reject(new Error(`the input probe document ${PAGE} has not loaded`));
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    region.post({ probeinput: "request", id, action, params }).catch((error) => {
      pending.delete(id);
      reject(error);
    });
  });
};
await region.load(PAGE);

const targetOf = (params) => {
  if (!TARGETS.includes(params?.target)) throw new TypeError(`probeinput target must be field or document, not ${JSON.stringify(params?.target)}`);
  return params.target;
};
const commands = {
  "probeinput.clear": async () => {
    field.clear();
    await requestDocument("clear", {});
    routing.set({ ...routing.read(), forwarded: [] });
    return null;
  },
  "probeinput.select": async (params) => {
    const { value, start, end } = params;
    if (targetOf(params) === "field") field.select({ value, start, end });
    else await requestDocument("select", { value, start, end });
    return null;
  },
  "probeinput.clock": (params) => (targetOf(params) === "field" ? field.clock() : requestDocument("clock", {})),
};
for (const [name, run] of Object.entries(commands)) await bridge.commands.register(name, run);
// The view field runs probeinput.select with its own value and selection on change, so a value that a person enters is the
// operation of a declared command (docs/spec/exposure.md#user-interface); the value and selection stand, so the run changes nothing.
const binder = createBinder((name, params) => commands[name](params), {
  check(name) {
    if (!(name in commands)) throw new Error(`command ${name} is not a command of the input probe`);
  },
});
binder.bind(fieldElement, "probeinput.select", () => ({
  target: "field", value: fieldElement.value, start: fieldElement.selectionStart, end: fieldElement.selectionEnd,
}), {
  event: "change",
  // default: a refusal that is not an Error carries its value as the text.
  failed: (error) => bridge.runtime.error("probeinput field", String(error?.message ?? error)) });
await expose.status("probeinput.field", field.read, field.subscribe);
await expose.status("probeinput.document", regionState.read, regionState.subscribe);
await expose.status("probeinput.routing", routing.read, routing.subscribe);
await expose.element("probeinput.field", fieldElement);
await expose.element("probeinput.text", document.getElementById("text"));
