// A view document for the tests of the views of plugins and fixture probes. The module needs jsdom, which the importer provides.
// It is a jsdom window on soksak://<plugin>/ with the injected start script of the host (view-start.js of this package), the view bridge of core (createViewBridge) and the exposure of core (createExpose),
// the modules that a view page of a plugin builds in its app.js. The peer of the wire is the host side of the sok-view handler, which a
// view-wire case records (docs/spec/cases/view-wire/README.md): each call of the view is answered with the reply of the next step of
// the case, and the notices and requests of the host reach the view in the order of the case. The consumer names the folder of its
// view-wire cases with the option `cases`, a URL. jsdom has no layout engine, so the sizes of the view and of its elements are data of `layout`.
import { readFileSync } from "node:fs";
import { inspect, isDeepStrictEqual } from "node:util";
import { runInContext } from "node:vm";
import { JSDOM } from "jsdom";
import { createExpose } from "./index.js";
import { createViewBridge } from "./view.js";
import { createWire, readCase } from "./wire-case.js";

// The error code of a failed call, as the workbench and the log handler of the host reply (the surface modules of the workbench).
const FAILURE_CODE = -32000;
const VARIABLE = /^\$[a-z][a-z0-9-]*$/;
const STEP_KINDS = ["call", "reply", "notice", "request"];
const TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];
const SOURCES = ["host", "page"];
const LOG_COMMAND = "runtime.log";

// The core declarations that the host gives every view page (docs/spec/native-surfaces.md#view-surfaces): the entries of a surface
// document, in the form of the start values of a view, as the view tests of this package write them.
const CORE_DECLARATIONS = {
  status: ["document", "input"].map((name) => ({ name: `core.surface.${name}`, description: name, schema: {} })),
  commands: [
    { name: "core.surface.hit", description: "Hits the document.", params: { type: "object" }, result: { type: "boolean" } },
    { name: "core.surface.clock", description: "Reads the document clock.", params: { type: "object" }, result: { type: "object" } },
  ],
  element: [],
};
const START = readFileSync(new URL("./view-start.js", import.meta.url), "utf8");

/** One turn of the event loop: runs every microtask that the call layer of the view queued before it. */
export const turn = () => new Promise((resolve) => setImmediate(resolve));

const SHAPE = {
  subject: "view",
  identity: "command",
  params: "params",
  noticeData: "data",
  callLabel: "a command",
  logName: LOG_COMMAND,
  kinds: ["call", "reply", "notice", "request"],
  header: (kase, fail) => {
    if (typeof kase.plugin !== "string" || kase.plugin === "") fail("plugin must be the non-empty id of the plugin of the view");
  },
  others: {
    request(request, where, fail, only) {
      if (!Number.isInteger(request.id)) fail(`${where} request must have an integer id`);
      if (typeof request.command !== "string" || request.command === "") fail(`${where} request must name a command`);
      only(["id", "command", "params"]);
    },
  },
};

/**
 * Opens the view of the case `name` with the start values `start` (window.sokSurface). `cases` is the URL of the folder of the view-wire
 * cases, which the consumer names. The host side of the wire is the case: each call
 * of the view is answered with the reply of the next step of the case, in the order of the steps. The calls of the command runtime.log
 * form one stream, because the page writes them at instants that no other call determines, and every other call forms the other stream,
 * as for the page-wire cases. A call that deviates from its stream is answered with an error and kept as a failure; close() throws the
 * failures and the steps of the case that were not played. `declarations` are the exposure declarations of the plugin
 * (window.sokSurface.declarations). `layout` is {width, height, scale, content, rect(element)} in CSS pixels: the size of the view,
 * its backing scale, the size of the content that its root scrolls (default the size of the view) and the rectangle of an element.
 *
 * Returns {window, bridge, expose, sent, calls, host, close}. sent holds every message of the view in order, calls the
 * {command, params} of the calls (with cids when the call carries them), deliverNotice(event, data) plays the next step, which must be a
 * notice of the host (event and data are what the test expects it to carry), release() settles the oldest held reply, and close ends the view
 * as a page ends: pagehide, then the window is removed after the writer chain of the page ended, then the check that the case was played.
 */
export async function openView(name, { cases, start, declarations = {}, layout = {}, html = "<!doctype html><body></body>" }) {
  if (!(cases instanceof URL)) throw new TypeError(`openView requires the case folder \`cases\` as a URL, found ${inspect(cases)}`);
  const kase = readCase(cases, name, SHAPE);
  const { plugin, steps } = kase;
  const wire = createWire(name, kase, SHAPE);
  const dom = new JSDOM(html, { url: `soksak://${plugin}/`, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const sent = [];
  const calls = [];
  Object.defineProperty(globalThis, "window", { value: window, configurable: true, writable: true });
  window.webkit = { messageHandlers: { "sok-view": { postMessage: () => {} } } };
  window.sokTheme = { scheme: "dark", tokens: {} };
  runInContext(START, dom.getInternalVMContext());
  // The start values of a view hold the core declarations before the declarations of its plugin.
  // default: a view that declares nothing of a kind has only the core declarations of that kind.
  const merged = Object.fromEntries(["status", "commands", "element"].map((kind) => [kind, [...CORE_DECLARATIONS[kind], ...(declarations[kind] ?? [])]]));
  window.sokSurface = { ...start, declarations: merged, levels: {} };
  // jsdom lays nothing out: the size of the view and the rectangle of each element are the data of the layout.
  if (layout.width !== undefined) Object.defineProperty(window, "innerWidth", { value: layout.width, configurable: true, writable: true });
  if (layout.height !== undefined) Object.defineProperty(window, "innerHeight", { value: layout.height, configurable: true, writable: true });
  // The visual viewport of the platform follows the size of the view, and it is an event target.
  const viewport = new window.EventTarget();
  Object.defineProperties(viewport, { width: { get: () => window.innerWidth }, height: { get: () => window.innerHeight } });
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
  // jsdom has no ResizeObserver, and without a layout engine nothing resizes: the observer takes its targets and notifies none, so a
  // size change of the view reaches the page through the resize event of the window, which the test dispatches.
  // The observer keeps its callback and targets, and the test delivers a size change with notify(entries).
  const observers = [];
  window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
    observe(target) { this.targets.push(target); }
    unobserve() {}
    disconnect() { this.disconnected = true; }
    notify(entries) { this.callback(entries, this); }
  };
  // default: a layout without a scale is a display of one device pixel per CSS pixel.
  Object.defineProperty(window, "devicePixelRatio", { value: layout.scale ?? 1, configurable: true });
  // The scroll extent of the document root: the content that the layout names, or the size of the view.
  for (const [property, size, view] of [["scrollWidth", "width", "innerWidth"], ["scrollHeight", "height", "innerHeight"]]) {
    // default: a layout that names no content size has content of the size of the view, as a document that does not scroll.
    Object.defineProperty(window.document.documentElement, property, { get: () => layout.content?.[size] ?? window[view], configurable: true });
  }
  if (layout.rect !== undefined) window.Element.prototype.getBoundingClientRect = function rect() { return layout.rect(this); };
  const host = (message) => window.dispatchEvent(new window.MessageEvent("message", { data: { sok: 1, ...message }, source: window }));

  // The events of the batches that the view sent to the event writer of the host, which logged() reads.
  const events = [];
  const answer = (id, outcome) => {
    if (outcome.error) return host({ id, error: { code: FAILURE_CODE, message: outcome.error.message } });
    const { reply } = outcome;
    // default: a step of the case without a result records the reply null, which the host sends as the result.
    return host({ id, ...("error" in reply ? { error: { code: FAILURE_CODE, message: reply.error } } : { result: wire.substitute(reply.result) ?? null }) });
  };
  const reply = async (id, outcome, command) => {
    // The host answers after the call returned to its caller, as a host on the other side of the handler does.
    await null;
    if (!outcome.error && outcome.reply.held) {
      wire.hold(outcome.index, command, () => answer(id, outcome));
      return;
    }
    answer(id, outcome);
  };
  // The waiters that a recorded message of the view ends: each runs after every message and removes itself when it is satisfied.
  const waiters = new Set();
  const sentWhere = (predicate) => new Promise((resolve) => {
    const check = () => {
      const found = sent.find(predicate);
      if (found === undefined) return;
      waiters.delete(check);
      resolve(found);
    };
    waiters.add(check);
    check();
  });
  const reports = [];
  const bridge = createViewBridge({
    handler: {
      postMessage: (message) => {
        sent.push(structuredClone(message));
        for (const waiter of [...waiters]) waiter();
        if (message.command === undefined) return;
        const recorded = { command: message.command, params: structuredClone(message.params) };
        if (message.cids !== undefined) recorded.cids = structuredClone(message.cids);
        calls.push(recorded);
        const outcome = wire.match(wire.onTheWire(message));
        if (message.command === LOG_COMMAND && message.params?.action === "batch" && !outcome.error) events.push(...message.params.events);
        reply(message.id, outcome, message.command);
      },
    },
    report: (event) => reports.push(event),
  });
  const expose = createExpose({
    register: bridge.exposure.register, reply: bridge.exposure.reply, changed: bridge.exposure.changed,
    report: (text) => bridge.runtime.error(`${plugin} exposure`, text),
    onRequest: (listener) => bridge.runtime.native.on("exposure-request", listener),
  }, () => window.sokSurface.declarations);
  // The next step of the case that the host plays, which must be of `kind`; the cursor moves past it.
  const nextHostStep = (kind, what) => {
    const step = wire.peek();
    if (!step || !(kind in step)) throw wire.fail(`${what} found ${step ? JSON.stringify(step) : "no further step"} at step ${wire.cursor}`);
    wire.advance();
    return step[kind];
  };
  const sameAs = (what, expected, requested) => {
    // The test names its data as JavaScript values; the wire carries them as JSON, so an undefined member is absent.
    // default: a request without params is compared as null, as the wire carries it.
    if (!isDeepStrictEqual(expected ?? null, JSON.parse(JSON.stringify(requested ?? null)))) throw wire.fail(`${what}: the case records ${JSON.stringify(expected)}, the test asked for ${JSON.stringify(requested)}`);
  };
  // A request of the host to the view: a command of the view (the answer is {sok, reply, result|error}) and an exposure request
  // (the answer is the exposureReply call of the view with the same id). Both are steps of the case.
  const run = async (command, params = null) => {
    const request = nextHostStep("request", `run ${command}`);
    if (request.command !== command) throw wire.fail(`run ${command}: the case requests ${request.command}`);
    sameAs(`run ${command}`, request.params, params);
    host({ id: request.id, command, params });
    const answered = await sentWhere((message) => message.reply === request.id);
    if ("error" in answered) throw new Error(answered.error.message);
    return answered.result;
  };
  const exposed = async (method, params) => {
    const notice = nextHostStep("notice", `exposed ${method}`);
    if (notice.event !== "exposure-request" || notice.data.method !== method) throw wire.fail(`exposed ${method}: the case has ${JSON.stringify(notice)}`);
    sameAs(`exposed ${method}`, notice.data.params, params);
    const { id } = notice.data;
    host({ event: notice.event, data: wire.substitute(notice.data) });
    const found = await sentWhere((message) => message.command === "runtime.native.call" && message.params.name === "exposureReply" && message.params.payload.id === id);
    const { error, result } = found.params.payload;
    if (error !== undefined) throw new Error(error.message);
    return result;
  };
  return {
    window, bridge, expose, sent, calls, reports, run, observers, events,
    /** The names of the exposure entries of `kind` that the plugin of the view registered, in order; the core entries are left out. */
    registered: (kind) => calls
      .filter(({ command, params }) => command === "runtime.native.call" && params.name === "registered" && params.payload.kind === kind)
      .map(({ params }) => params.payload.name).filter((entry) => !entry.startsWith("core.")),
    /** Settles with the first event of the writer of the page named `event` after the batch that carries it was sent. */
    logged: async (event) => (await sentWhere((message) => message.command === LOG_COMMAND && message.params.events?.some((item) => item.event === event)))
      .params.events.find((item) => item.event === event),
    /** The value of the exposed status `name`, read through the exposure request that the host forwards. */
    status: (statusName) => exposed("status.get", { name: statusName }),
    /** The result of the exposed command `name`, run through the exposure request that the host forwards. */
    command: (commandName, params) => exposed("command.run", { name: commandName, params }),
    exposed,
    /** The values that the exposed status `name` reported to the host after it was watched, in order. */
    changes: (statusName) => calls.filter(({ command, params }) => command === "runtime.native.call" && params.name === "changed" && params.payload.name === statusName)
      .map(({ params }) => params.payload.value),
    /**
     * Plays the next step, which must be a notice of the host, by sending it to the view. `event` names the event that the test expects,
     * and `expected` is the data that the test expects the notice to carry; a notice of another event or other data is a failure.
     */
    deliverNotice(event, ...expected) {
      const notice = nextHostStep("notice", "deliverNotice");
      if (notice.event !== event) throw wire.fail(`deliverNotice expected ${event}, the case has ${JSON.stringify(notice)}`);
      if (expected.length > 0) sameAs(`deliverNotice ${event}`, notice.data, expected[0]);
      host({ event: notice.event, ...("data" in notice ? { data: wire.substitute(notice.data) } : {}) });
    },
    /** Settles the oldest held reply, or the held reply that the key names (the index of its call step or the name of its command). */
    release: wire.release,
    async close() {
      window.dispatchEvent(new window.Event("pagehide"));
      await turn();
      delete globalThis.window;
      window.close();
      wire.finish();
    },
  };
}
