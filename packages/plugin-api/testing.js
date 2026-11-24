// A view document for the tests of the views of plugins and fixture probes. The module needs jsdom, which the importer provides.
// It is a jsdom window on soksak://<plugin>/ with the injected start script of the host (view-start.js of this package), the view bridge of core (createViewBridge) and the exposure of core (createExpose),
// the modules that a view page of a plugin builds in its app.js. The peer of the wire is the host side of the sok-view handler, which a
// view-wire case records (docs/spec/cases/view-wire/README.md): each call of the view is answered with the reply of the next step of
// the case, and the notices and requests of the host reach the view in the order of the case. The consumer names the folder of its
// view-wire cases with the option `cases`, a URL. jsdom has no layout engine, so the sizes of the view and of its elements are data of `layout`.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect, isDeepStrictEqual } from "node:util";
import { runInContext, runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { createExpose } from "./index.js";
import { answerViewCall } from "./view-answer.js";
import { createViewBridge } from "./view.js";
import { createTestHost } from "./view-host.js";
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
// The loads of page modules in this process: each load gets a URL that no earlier load has, so Node imports the module anew.
let pageLoads = 0;

// The URL of the test process. An open view binds the global names of its window, so the test reads its own URL through this name.
const NodeURL = URL;
// The names that every JavaScript realm defines (the globals of a fresh context and the members of its Object.prototype). A view window
// does not bind them, so the test process keeps its own.
const REALM_NAMES = new Set(runInNewContext("[globalThis, Object.prototype]").flatMap((object) => Object.getOwnPropertyNames(object)));
// The views that are open, the last opened last, each with its window and the timers that the page starts (null in case mode). The global
// names answer from the last window, so each view reads its own window; the timers are recorded in the last view.
const openViews = [];
// The descriptors that the global names had before the first open view bound them; null while no view is open.
let savedGlobals = null;
// The names that the test process defines and that a page reads from its window: fetch, which the view serves its files through. jsdom calls
// none of them, so the window answers them without a call back into the binding.
const SHADOWED = ["fetch"];
// The timers that a page starts as bare names. jsdom calls these names too, so the recording wrapper calls the original timer of the process
// and never the binding.
const TIMERS = ["setTimeout", "setInterval"];
// The calls of the window that are running now and start timers of the window itself: jsdom starts an interval for its first animation
// frame, which the page did not start, so the timers that such a call starts are not recorded.
let internalCalls = 0;

/** The names of the window of a view and of its prototype chain, except the names of every realm. */
const windowNames = (window) => {
  const names = new Set();
  for (let object = window; Object.getPrototypeOf(object) !== null; object = Object.getPrototypeOf(object)) {
    for (const name of Object.getOwnPropertyNames(object)) names.add(name);
  }
  return [...names].filter((name) => !REALM_NAMES.has(name));
};

/**
 * Binds the names of the window that the test process does not define as globals, as the global object of a browser page is its window: a
 * page module that names `document` or `addEventListener` reads the member of the window. A function without a prototype is bound to the
 * window, so a call with no receiver works as in a page; a constructor is the constructor of the window, so `instanceof` matches the window.
 * A name that the test process defines keeps the test process value, because jsdom calls it (Event, URL, timers), except the SHADOWED names.
 * The first open view makes the binding; later views only push their window and timers.
 */
const bindGlobals = (window, timers) => {
  if (openViews.length === 0) {
    savedGlobals = new Map();
    const names = windowNames(window).filter((name) => !(name in globalThis) || (SHADOWED.includes(name) && window[name] !== undefined));
    for (const name of names) {
      savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() {
          const current = openViews.at(-1).window;
          const value = current[name];
          return typeof value === "function" && !("prototype" in value) ? value.bind(current) : value;
        },
        set(value) { openViews.at(-1).window[name] = value; },
      });
    }
    for (const name of TIMERS) {
      savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      const original = globalThis[name];
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: function started(...args) {
          // default: a timer started without a delay runs after a delay of 0, as the window runs it.
          if (internalCalls === 0) openViews.at(-1).timers?.push({ kind: name, delay: args[1] ?? 0 });
          return original.apply(this, args);
        },
      });
    }
  }
  openViews.push({ window, timers });
};

/** Ends the binding of a window. The last open view keeps the names; when no view is open, the saved descriptors are put back. */
const releaseGlobals = (window) => {
  const index = openViews.findIndex((view) => view.window === window);
  if (index === -1) throw new Error("the window of the view is not open");
  openViews.splice(index, 1);
  if (openViews.length > 0) return;
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor === undefined) delete globalThis[name];
    else Object.defineProperty(globalThis, name, descriptor);
  }
  savedGlobals = null;
};

/** Records each animation frame that the page window starts in `timers`, as {kind, delay: null}, and starts it as the window does. */
const observeFrames = (window, timers) => {
  const original = window.requestAnimationFrame;
  window.requestAnimationFrame = function started(...args) {
    timers.push({ kind: "requestAnimationFrame", delay: null });
    internalCalls += 1;
    try {
      return original.apply(this, args);
    } finally {
      internalCalls -= 1;
    }
  };
};

/**
 * Serves the files of the plugin directory `root` to window.fetch as the application serves them: an address soksak://<plugin>/<path> and a
 * file address name a path of the directory, which answers with the bytes of the file and status 200. An address outside the directory and a
 * missing file answer status 404. Another error of the file system rejects the fetch, because it is no answer of the app.
 */
const serveFiles = (window, plugin, root) => {
  const folder = resolve(fileURLToPath(root));
  window.fetch = async (input) => {
    const url = new NodeURL(String(input), window.location.href);
    let file = null;
    if (url.protocol === "soksak:" && url.host === plugin) file = join(folder, decodeURIComponent(url.pathname));
    else if (url.protocol === "file:") file = fileURLToPath(url);
    const inside = file !== null && isInside(folder, file);
    if (!inside) return new Response(null, { status: 404 });
    try {
      return new Response(await readFile(file), { status: 200 });
    } catch (error) {
      if (error.code === "ENOENT") return new Response(null, { status: 404 });
      throw error;
    }
  };
};

// Whether the file lies inside the folder: the path relative to the folder names no parent folder and is not absolute.
const isInside = (folder, file) => {
  const path = relative(folder, file);
  return path !== "" && path.split(sep)[0] !== ".." && !isAbsolute(path);
};

/**
 * jsdom has no document.adoptedStyleSheets, which the WebKit of the application has. The document keeps the list of constructed style sheets
 * that the page assigns, and refuses a value that is not an array of CSSStyleSheet. jsdom has no cascade, so the rules of the sheets do not
 * apply to the elements of the view; the list is the observable state.
 */
const adoptStyleSheets = (document, CSSStyleSheet) => {
  let sheets = [];
  Object.defineProperty(document, "adoptedStyleSheets", {
    configurable: true,
    get: () => sheets,
    set(value) {
      if (!Array.isArray(value) || !value.every((sheet) => sheet instanceof CSSStyleSheet)) {
        throw new TypeError("adoptedStyleSheets takes an array of CSSStyleSheet");
      }
      sheets = [...value];
    },
  });
};

// The module URLs that the open host-mode views answer for their contributions, each mapped to the URL of its file. The page imports the
// answered URL, which Node cannot load (its loader supports the file and data schemes only), so the resolve hook maps it to the file.
const contributedModules = new Map();
let contributionHooks = false;

/** Maps the module URLs of the answered contributions to the files that the view names (the hook is registered by the first view that has one). */
const registerContributed = (modules) => {
  if (modules.size === 0) return;
  if (!contributionHooks) {
    contributionHooks = true;
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const target = contributedModules.get(specifier);
        if (target === undefined) return nextResolve(specifier, context);
        return { url: target, shortCircuit: true };
      },
    });
  }
  for (const [url, target] of modules) contributedModules.set(url, target);
};

/** Removes the module URLs that a view registered when it closes. */
const unregisterContributed = (modules) => {
  for (const url of modules.keys()) contributedModules.delete(url);
};

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
 * Opens a view page of a plugin with the start values `start` (window.sokSurface). The view answers its calls in one of two modes.
 *
 *     cases  the URL of the folder of the view-wire cases, with `name` the case of the view. The host side of the wire is the case: each
 *            call of the view is answered with the reply of the next step of the case, in the order of the steps. The calls of the
 *            command runtime.log form one stream, because the page writes them at instants that no other call determines, and every other
 *            call forms the other stream, as for the page-wire cases. A call that deviates from its stream is answered with an error and
 *            kept as a failure; close() throws the failures and the steps of the case that were not played.
 *     host   the fixtures of createTestHost (view-host.js). Each call of the view is answered by answerViewCall with the options of the
 *            test host, as the workbench answers a view call; the name is not read. The calls of runtime.log are answered here, because
 *            answerViewCall has no handler for them: a batch is stored in events, and the clock is read from the clocks of the test process.
 *            close() throws the routes that had no fixture (observed.failures).
 *
 * Passing both or neither of `cases` and `host` throws a TypeError. `declarations` are the exposure declarations of the plugin
 * (window.sokSurface.declarations). `layout` is {width, height, scale, content, rect(element)} in CSS pixels: the size of the view,
 * its backing scale, the size of the content that its root scrolls (default the size of the view) and the rectangle of an element.
 *
 * In host mode the window has no bridge of the test until view.bridge is read. The page module of the plugin is loaded with view.load(url),
 * and it builds the bridge of the view itself, as the application does; view.request(command, params) runs a command of that page through
 * an exposure request, and view.sidecarMessage(sidecar, id, {body, cids}) delivers a sidecar message to the page's sidecar listener.
 *
 * Host-mode options beyond the fixtures: `start` null opens the view without window.sokSurface, so a page that reads it refuses to load;
 * `page` is the path of the page of the view in its plugin, as its composition declares it (for example ui/view.html): the window has
 * the address soksak://<plugin>/<page>, so a relative address of the page resolves as the app resolves it. The default is the root of the plugin.
 * `root` is the file URL of the plugin directory, whose files window.fetch serves to the page (a path outside it or a missing file answers
 * status 404); each module that the contributions fixture names is imported by the page through the URL that the host answers.
 * While a host-mode view is open its window names are the global names of the test process, except the names that the process defines
 * (jsdom calls them), so a page reads `document`, `addEventListener`, `Element`, `requestAnimationFrame` and the other window names as in
 * a browser; a second view opened while one is open has its window as the global `window`, and closing it leaves the window of the first.
 * The Node names that a page reads from the process (Event, URL, setTimeout) stay the process values. The timers that the page starts
 * are recorded in view.observed.timers (kind, delay) and still run.
 *
 * Returns {window, bridge, expose, sent, calls, reports, run, observers, events, change, registered, logged, status, command, exposed,
 * changes, deliverNotice, release, observed, push, load, request, sidecarMessage, settled, close}. bridge and expose are read at the first
 * access, and in case mode they exist from the open. sent holds every message of the view in order. calls holds each command call of the
 * view in the order it was made, as {command, params} (with cids when the call carries them); a test reads the order from it, and no
 * call is reordered. change (host mode, null in case mode) holds the changes of the window (settings, textSize, logLevels, status, run,
 * data, leftOut, frame), each delivered to the page as the host delivers it: the view events that the changes push reach the page before
 * the returned promise settles. The members that play case steps (run, exposed, status, command, deliverNotice
 * and release) throw in host mode, which has no case. observed is the observed record of the test host in host mode, and null in case
 * mode. In host mode, push(event, data) delivers a host event through the subscriptions of the view, and each viewEvent that the
 * subscription forwards reaches the page as the host message {event, data}; settled() resolves when the calls of the page have
 * replied and the route work of the test host has ended. close ends the view as a page ends: pagehide, then the window is removed
 * after the writer chain of the page ended, then the check that the case was played (case mode) or the failures (host mode).
 */
export async function openView(name, { cases, host: fixtures, start, declarations = {}, layout = {}, html = "<!doctype html><body></body>", root, page = "" }) {
  if (cases !== undefined && fixtures !== undefined) throw new TypeError("openView takes either the case folder `cases` or the host fixtures `host`, not both");
  if (fixtures === undefined && !(cases instanceof URL)) throw new TypeError(`openView requires the case folder \`cases\` as a URL or the host fixtures \`host\`, found ${inspect(cases)}`);
  // start is the start values of the view, or null for a view without window.sokSurface (a page that reads it refuses to load).
  if (start === undefined) throw new TypeError("openView requires the start values of the view, or null for a view without window.sokSurface");
  // page is the path of the page of the view in its plugin, as the composition declares it; the window has its address in the plugin.
  if (typeof page !== "string" || page.startsWith("/") || page.split("/").includes("..")) throw new TypeError(`openView page must be a path of the plugin, found ${inspect(page)}`);
  if (root !== undefined && !(root instanceof NodeURL && root.protocol === "file:")) throw new TypeError(`openView root must be the file URL of the plugin directory, found ${inspect(root)}`);
  // In host mode name is the plugin id of the view, so the fixtures do not name it a second time.
  if (fixtures !== undefined && "plugin" in fixtures) throw new TypeError("openView host fixtures take no plugin: the plugin of the view is the name");
  const testHost = fixtures === undefined ? null : createTestHost({ ...fixtures, plugin: name, dialog: start?.dialog ?? null });
  const kase = testHost === null ? readCase(cases, name, SHAPE) : null;
  const plugin = testHost === null ? kase.plugin : name;
  const wire = kase === null ? null : createWire(name, kase, SHAPE);
  const dom = new JSDOM(html, { url: `soksak://${plugin}/${page}`, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const sent = [];
  const calls = [];
  // The sok-view handler of the window is the host side of the page: in host mode each message of the page, the ready message of the
  // start script included, is answered by the test host. In case mode the case answers the calls of the bridge, and the handler is idle.
  window.webkit = { messageHandlers: { "sok-view": { postMessage: (message) => { if (testHost !== null) deliverFromView(message); } } } };
  window.sokTheme = { scheme: "dark", tokens: {} };
  // The start values of a view hold the core declarations before the declarations of its plugin.
  // default: a view that declares nothing of a kind has only the core declarations of that kind.
  const merged = Object.fromEntries(["status", "commands", "element"].map((kind) => [kind, [...CORE_DECLARATIONS[kind], ...(declarations[kind] ?? [])]]));
  if (start !== null) window.sokSurface = { ...start, declarations: merged, levels: {} };
  // The style sheets, the files of the plugin and the timers of the page: each is set before the page module runs.
  adoptStyleSheets(window.document, window.CSSStyleSheet);
  if (root !== undefined) serveFiles(window, plugin, root);
  if (testHost !== null) observeFrames(window, testHost.observed.timers);
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
  // The calls of the page that are answered in host mode, until their reply reached the page.
  const pendingCalls = new Set();
  // The writer calls of the page in host mode: a batch is stored in events, and the clock is read from the clocks of the test process,
  // which the page takes as the clock of the host before its first batch leaves.
  const logCall = async ({ params }) => {
    if (params?.action === "batch") {
      if (!Array.isArray(params.events)) throw new TypeError("runtime.log batch requires the array events");
      // The host refuses a batch with the fault of the test host, and then stores none of its events.
      await testHost.logBatch(params.events);
      events.push(...params.events);
      return null;
    }
    if (params?.action === "clock") return { ts_us: Math.round(Date.now() * 1000), mono_ns: Math.round(Number(process.hrtime.bigint())) };
    throw new TypeError(`runtime.log action ${JSON.stringify(params?.action)} is not served in host mode`);
  };
  // The view events that the host pushed and that have not reached the page yet, by their index in the observed document of the test host.
  let forwarded = 0;
  // Delivers to the page each view event that the subscriptions pushed since the last delivery, in order: as the host pushes an event, the
  // page receives it, whether a host change, a host event or a call of the page caused it.
  const forwardPushed = () => {
    if (testHost === null) return;
    const entries = testHost.observed.document;
    const end = entries.length;
    for (const { name, payload } of entries.slice(forwarded, end)) {
      if (name === "viewEvent") host({ event: payload.event, data: payload.data });
    }
    forwarded = end;
  };
  // The reply of the host to a call of the page: the result of the handler, or the error code of a failed call, as the workbench replies.
  const answerFromHost = (message) => {
    const request = structuredClone(message);
    const work = (request.command === LOG_COMMAND ? logCall(request) : answerViewCall(request, testHost.options))
      .then(
        // default: a call that answers undefined replies null, as the wire carries no undefined.
        (result) => { forwardPushed(); host({ id: request.id, result: result ?? null }); },
        // default: a thrown value that is not an Error replies with its text, as the host relays it.
        (error) => { forwardPushed(); host({ id: request.id, error: { code: FAILURE_CODE, message: error?.message ?? String(error) } }); },
      )
      .finally(() => pendingCalls.delete(work));
    pendingCalls.add(work);
  };
  // The page has no case step in host mode, so a member that plays one names the case that it needs.
  const caseWire = (what) => {
    if (wire === null) throw new Error(`openView host mode has no case steps: ${what} needs the case folder \`cases\``);
    return wire;
  };
  const hostOnly = (what) => {
    if (testHost === null) throw new Error(`openView case mode has no host fixtures: ${what} needs the host fixtures \`host\``);
    return testHost;
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
  // Each message that the page posts through the sok-view handler, by the bridge or by the start script: it is recorded, and a call is
  // answered by the test host (host mode) or by the case (case mode).
  const deliverFromView = (message) => {
    sent.push(structuredClone(message));
    for (const waiter of [...waiters]) waiter();
    if (message.command === undefined) return;
    const recorded = { command: message.command, params: structuredClone(message.params) };
    if (message.cids !== undefined) recorded.cids = structuredClone(message.cids);
    calls.push(recorded);
    if (testHost !== null) {
      answerFromHost(message);
      return;
    }
    const outcome = wire.match(wire.onTheWire(message));
    if (message.command === LOG_COMMAND && message.params?.action === "batch" && !outcome.error) events.push(...message.params.events);
    reply(message.id, outcome, message.command);
  };
  // The page module reads the globals of its window, so the globals are bound before the start script runs and before any page module loads.
  const modules = testHost === null ? new Map() : testHost.contributedModules();
  registerContributed(modules);
  bindGlobals(window, testHost === null ? null : testHost.observed.timers);
  // The start script posts the ready message as soon as it runs, so it runs after deliverFromView, which the handler of the window calls.
  runInContext(START, dom.getInternalVMContext());
  const reports = [];
  // The bridge of the view is created at the first read of view.bridge, or at the open of a case, so a page module that the test loads
  // builds the one bridge of the view. The page module builds its bridge on the window like the application does: a second bridge on
  // the same window is refused by the start script (view channel already has a message listener).
  let bridgeValue = null;
  let exposeValue = null;
  let pageLoaded = false;
  const bridgeOf = () => {
    if (pageLoaded) throw new Error(`view ${plugin} has a page loaded: its page module holds the view bridge, so view.bridge is not available`);
    if (bridgeValue === null) {
      bridgeValue = createViewBridge({ handler: { postMessage: deliverFromView }, report: (event) => reports.push(event) });
    }
    return bridgeValue;
  };
  const exposeOf = () => {
    if (exposeValue === null) {
      const bridge = bridgeOf();
      exposeValue = createExpose({
        register: bridge.exposure.register, reply: bridge.exposure.reply, changed: bridge.exposure.changed,
        report: (text) => bridge.runtime.error(`${plugin} exposure`, text),
        onRequest: (listener) => bridge.runtime.native.on("exposure-request", listener),
      }, () => window.sokSurface.declarations);
    }
    return exposeValue;
  };
  if (testHost === null) bridgeOf();
  // The next step of the case that the host plays, which must be of `kind`; the cursor moves past it.
  const nextHostStep = (kind, what) => {
    const cases = caseWire(what);
    const step = cases.peek();
    if (!step || !(kind in step)) throw cases.fail(`${what} found ${step ? JSON.stringify(step) : "no further step"} at step ${cases.cursor}`);
    cases.advance();
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
  // The reply of the page to the exposure request id: the payload of its exposureReply call, which rejects with the error of the page.
  const exposureAnswer = async (id) => {
    const found = await sentWhere((message) => message.command === "runtime.native.call" && message.params.name === "exposureReply" && message.params.payload.id === id);
    const { error, result } = found.params.payload;
    if (error !== undefined) throw new Error(error.message);
    return result;
  };
  const exposed = async (method, params) => {
    const notice = nextHostStep("notice", `exposed ${method}`);
    if (notice.event !== "exposure-request" || notice.data.method !== method) throw wire.fail(`exposed ${method}: the case has ${JSON.stringify(notice)}`);
    sameAs(`exposed ${method}`, notice.data.params, params);
    const { id } = notice.data;
    host({ event: notice.event, data: wire.substitute(notice.data) });
    return exposureAnswer(id);
  };
  // The reply of the page to the command request id (host mode): {sok: 1, reply: id, result} or {sok: 1, reply: id, error}.
  const commandAnswer = async (id) => {
    const answered = await sentWhere((message) => message.reply === id);
    if ("error" in answered) throw new Error(answered.error.message);
    return answered.result;
  };
  // A host change of the test host, or a host event, delivered as the host delivers it: the view events that the subscriptions push are
  // handed to the page in order, after the subscriptions forwarded them.
  const deliverPushed = async (what, act) => {
    const hosted = hostOnly(what);
    act(hosted);
    // The subscription forwards the event on a later microtask; the turn lets that forward reach the test host before the wait.
    await turn();
    await hosted.settled();
    forwardPushed();
  };
  // The changes of the window of a host-mode view: each name of the test host change, delivered to the page.
  const change = testHost === null ? null : Object.fromEntries(Object.keys(testHost.change).map((step) => [
    step,
    (...args) => deliverPushed(`change.${step}`, (hosted) => hosted.change[step](...args)),
  ]));
  let requestIds = 0;
  return {
    window, sent, calls, reports, run, observers, events, change,
    /** The bridge of the view: the bridge of the test, which a case-mode view has from its open and a host-mode view creates here. */
    get bridge() { return bridgeOf(); },
    /** The exposure of the test (createExpose over the bridge). It is created with the bridge. */
    get expose() { return exposeOf(); },
    /**
     * Imports the page module at the URL into the window of the view (host mode). The module builds its bridge on the window, so the test
     * has no bridge of its own afterwards. Each load imports the module anew, so a test does not share the state of an earlier load.
     * Resolves with the module namespace. A view loads one page module.
     */
    async load(url) {
      hostOnly("load");
      if (!(url instanceof NodeURL)) throw new TypeError(`view.load requires the URL of the page module, found ${inspect(url)}`);
      if (pageLoaded) throw new Error(`view ${plugin} already has a page loaded: a view loads one page module`);
      if (bridgeValue !== null) throw new Error(`view ${plugin} already has a bridge: view.bridge was read, so a page module cannot load into the same view`);
      pageLoaded = true;
      const target = new NodeURL(url);
      target.searchParams.set("view", String(++pageLoads));
      return import(target.href);
    },
    /**
     * Runs the command `command` of the page as the host runs a command of a view (host mode): a command request with a fresh id, which the
     * page answers. Resolves with the result of the command, or rejects with its error. The commands of a page are registered with
     * runtime.command.register, so the host reaches them by a command request, not by an exposure request (native-surfaces.md, view commands).
     */
    request(command, params) {
      hostOnly("request");
      const id = ++requestIds;
      host({ id, command, params: structuredClone(params) });
      return commandAnswer(id);
    },
    /**
     * Delivers a sidecar message of the session `id` to the view (host mode), as the host posts it to a routed view: the page receives it on
     * its sidecar listener, with the cids of the message when it has any. A session without a route, which the page did not subscribe to, is refused.
     */
    sidecarMessage(name, id, message) {
      const posted = hostOnly("sidecarMessage").sidecarMessage(name, id, message);
      host(structuredClone(posted));
    },
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
    release: (...args) => caseWire("release").release(...args),
    /** The observed record of the test host in host mode, or null in case mode (view-host.js, observed). */
    observed: testHost === null ? null : testHost.observed,
    /** Delivers the host event `event` with `data` to the view (host mode): the subscriptions of the view forward it as a viewEvent. */
    push: (event, data) => deliverPushed("push", (hosted) => hosted.push(event, data)),
    /** Resolves when the calls of the page have replied and the route work of the test host has ended (host mode). */
    settled: async () => {
      const hosted = hostOnly("settled");
      do {
        await Promise.allSettled([...pendingCalls]);
        await hosted.settled();
        await turn();
      } while (pendingCalls.size > 0);
    },
    async close() {
      window.dispatchEvent(new window.Event("pagehide"));
      await turn();
      // The view ends its subscriptions with its page (createTestHost close, as the page ends them in its surface close).
      if (testHost !== null) await testHost.close();
      releaseGlobals(window);
      unregisterContributed(modules);
      window.close();
      if (wire !== null) wire.finish();
      if (testHost !== null && testHost.observed.failures.length > 0) throw new Error(testHost.observed.failures.join("\n"));
    },
  };
}
