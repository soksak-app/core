// Requests native surfaces and modal views from the application.
//
// Plugin modules mount into the application DOM. A page declares the frame of a logical surface, and the host places
// the native document and image regions on that surface.
// A modal document is shown in a separate native web view inside the main window.
//
// This file is not duplicated per application. The only difference between applications is the transport, which the
// runtime module (@soksak/runtime) handles.
import { emitEvent, reportRecord } from "./page-log.js";
import { trace } from "./performance.js";
import { host as bridge } from "@soksak/runtime";
import { plugins } from "./registry.js";
import { createClipboardBridge, createExpose, createLinkBridge, orderedSidecar } from "@soksak/plugin-api";
import { registerSurfacePort, registry } from "./exposure.js";
import { pluginSessionOf } from "./plugin-host.js";

/**
 * Returns the computed CSS color as [r, g, b, a]. The alpha is 1 when the color has none.
 *
 * The browser serializes the result of color-mix as color(srgb r g b / a), whose channels range over 0..1. The
 * channels of the rgb() notation range over 0..255, so this function scales them to match. The host receives colors
 * as 0..255.
 */
function rgba(css) {
  const text = String(css).trim();
  const n = text.match(/[\d.]+/g)?.map(Number);
  if (!n || n.length < 3) throw new Error(`the CSS color ${JSON.stringify(text)} has no red, green, and blue channels`);
  const unit = text.startsWith("color(") ? 255 : 1;
  return [n[0] * unit, n[1] * unit, n[2] * unit, n[3] === undefined ? 1 : n[3]];
}

/**
 * Returns the opaque color that results from compositing colour over ground.
 *
 * Some colors of the page are translucent and are composited over the plane inside the page. A native modal is
 * composited over the surfaces below it, so a translucent border would vanish over a white page.
 */
function over(colour, ground) {
  const [r, g, b, a] = rgba(colour);
  const [br, bg, bb] = rgba(ground);
  const mix = (c, d) => Math.round(c * a + d * (1 - a));
  return `rgb(${mix(r, br)}, ${mix(g, bg)}, ${mix(b, bb)})`;
}

/** Converts a rectangle relative to the plane into one relative to the page. */
function toPage(rect) {
  const plane = document.getElementById("plane").getBoundingClientRect();
  return { x: plane.left + rect.x, y: plane.top + rect.y, w: rect.w, h: rect.h };
}

/** Converts a rectangle relative to the page back into one relative to the plane. The application answers in page coordinates. */
function toPlane(rect) {
  const plane = document.getElementById("plane").getBoundingClientRect();
  return { x: rect.x - plane.left, y: rect.y - plane.top, w: rect.w, h: rect.h };
}

/**
 * The values that modal rendering needs. show and update send the same shape.
 *
 * The style sheets read the rules that the document actually holds. Collecting only `<style>` elements would miss
 * sheets attached by link, and the modal would receive markup without rules.
 */
function drawing(el) {
  const style = getComputedStyle(el);
  return {
    mode: el.dataset.nativeModal,
    card: cardFrame(el),
    // default: a modal without a label has an empty string as its title.
    title: el.getAttribute("aria-label") || "",
    className: el.className,
    html: el.innerHTML,
    // The native paint clip of the main document follows the surfaces of the main document and is not copied into the dialog document (docs/spec/native-modals.md).
    css: [...document.styleSheets]
      .filter((sheet) => !document.adoptedStyleSheets.includes(sheet) && !sheet.ownerNode?.hasAttribute("data-native-paint-clip"))
      .map((sheet) => [...sheet.cssRules].map((rule) => rule.cssText).join("\n"))
      .join("\n"),
    border: over(style.borderTopColor, style.backgroundColor),
  };
}

function cardFrame(el) {
  const r = el.getBoundingClientRect();
  const dialog = el.dataset.nativeModal === "dialog";
  return { x: dialog ? r.left : 0, y: dialog ? r.top : 0, w: r.width, h: r.height };
}

function overlayFrame(el, rect) {
  return el.dataset.nativeModal === "dialog"
    ? { x: 0, y: 0, w: innerWidth, h: innerHeight }
    : toPage(rect);
}

/** Keeps native input that passed through an application DOM modal from reaching the native surfaces. */
function windowOverlays() {
  if (!shown) return [];
  const el = document.getElementById(shown);
  if (!el || el.hidden) return [];
  if (el.dataset.nativeModal === "dialog") {
    return [{ x: 0, y: 0, w: innerWidth, h: innerHeight }];
  }
  const rect = el.getBoundingClientRect();
  return [{ x: rect.left, y: rect.top, w: rect.width, h: rect.height }];
}

/**
 * Whether the application runs this page.
 *
 * This value decides who draws surfaces, modals and shapes. When the application draws them they are native views;
 * otherwise this document imitates them with DOM. The way of drawing really differs, so the branch itself remains,
 * and this value is the single place where it branches.
 */
export const native = Boolean(bridge);

// The reload request of the host. The page is read again after every call it sent has received its reply (docs/spec/native-host.md#page-reload).
if (bridge) bridge.on("page-reload", () => bridge.reload());

/*
 * One ordered port per sidecar name. The host can process send calls concurrently, so the next send must be called
 * only after the previous one has finished; then the sidecar receives the messages in the order they were sent. All
 * surfaces that use the same sidecar share this order.
 */
const orderedSidecars = new Map();
function orderedSidecarPort(name) {
  if (!orderedSidecars.has(name)) {
    orderedSidecars.set(name, orderedSidecar({
      // The request must be sent after the failure listener is installed so that a failure caused by the request is not missed.
      send: (surface, body, cids) => listenSidecarFailures()
        .then(() => bridge.call("sidecarSend", { sidecar: name, surface, body, cids })),
    // Separately from the rejection that the caller receives, a failed send is written to the application log.
    }, (error) => {
      // default: the thrown value may not be an Error, so when it has no message the value itself is written as it is.
      report(`sidecar ${name}: send failed: ${error?.message ?? error}`);
    }));
  }
  return orderedSidecars.get(name);
}

/*
 * Sidecar failure handlers. The key is the sidecar name and the surface. One sidecar-failure listener per document
 * calls the handler, and a failure without a handler is reported as a page error (docs/spec/sidecars.md#page-interface).
 */
const failureHandlers = new Map();
const failureKey = (name, surface) => JSON.stringify([name, surface]);
let failureListener = null;
function listenSidecarFailures() {
  // default: the first request or subscription of a document installs the listener, and later ones wait for the same installation.
  failureListener ??= Promise.resolve(bridge.on("sidecar-failure", (failure) => {
    // A failure of a plugin session goes to its plugin host, which the registry of plugin-host.js delivers; no alert is shown for it.
    if (pluginSessionOf(failure?.surface) !== null) return;
    // default: a surface without a registered handler has nowhere to receive the failure, so the failure is reported as a page error.
    const handlers = [...(failureHandlers.get(failureKey(failure.sidecar, failure.surface)) ?? [])];
    if (handlers.length === 0) {
      dispatchEvent(new ErrorEvent("error", {
        message: `sidecar ${failure.sidecar} failed for surface ${failure.surface}: ${failure.reason}`,
      }));
      return;
    }
    for (const handler of handlers) handler(failure.reason);
  }));
  return failureListener;
}

/** Receives the failures of the surface surface of the sidecar name through fn(reason). The returned unsubscribe function completes after registration. */
function onSidecarFailure(name, surface, fn) {
  if (typeof fn !== "function") return Promise.reject(new TypeError("sidecar onFailure requires a listener"));
  const key = failureKey(name, surface);
  let handlers = failureHandlers.get(key);
  if (!handlers) failureHandlers.set(key, handlers = new Set());
  handlers.add(fn);
  return listenSidecarFailures().then(() => () => {
    handlers.delete(fn);
    if (handlers.size === 0 && failureHandlers.get(key) === handlers) failureHandlers.delete(key);
  });
}

/**
 * Sends a declared background session command without creating a native surface.
 * The tab id stays the sidecar surface key so that a surface shown later reattaches to the same persistent
 * actor.
 */
export function windowSidecar(name) {
  if (!bridge) return null;
  return {
    // cids are the correlation identifiers of the inputs that the request continues (docs/spec/sidecars.md#protocol).
    send: (surface, body, cids) => orderedSidecarPort(name).send(surface, body, cids),
    on: (surface, listener) => Promise.resolve(bridge.on("sidecar-message", (event) => {
      if (event?.sidecar === name && event?.surface === surface) listener(event.body);
    })),
    onFailure: (surface, listener) => onSidecarFailure(name, surface, listener),
  };
}

/**
 * Makes the persistent sidecar service close the sessions of this application that are not in surfaces, and returns {closed}.
 * A page without a host has no sidecar sessions, so the function returns null.
 */
export function retainSidecarSessions(surfaces) {
  if (!bridge) return Promise.resolve(null);
  return bridge.call("sidecarsRetain", { surfaces });
}

/* Surface modules mount into this document, so every native operation is limited to an explicit surface scope
   before it crosses the host boundary. */
export function surfaceContextRuntime(surface, declarations = {}) {
  const { surfaceId } = surface;
  if (typeof surfaceId !== "string" || !surfaceId) throw new TypeError("surface runtime requires surface.surfaceId");
  const invoke = (name, payload) => name === "report"
    ? reportRecord("error", payload)
    // default: a call without parameters omits the payload.
    : bridge.call(name, { ...(payload ?? {}), surface: surfaceId });
  const listeners = new Map();
  const on = (name, fn) => {
    let set = listeners.get(name);
    if (!set) listeners.set(name, set = new Set());
    set.add(fn);
    const registered = bridge.on(name, (event) => {
      if (event?.surface === surfaceId) fn(event);
    });
    return Promise.resolve(registered).then((off) => () => {
      set.delete(fn);
      off();
    });
  };
  const theme = (fn) => {
    if (typeof fn !== "function") throw new TypeError("surface theme requires a listener");
    const initial = bridge.call("theme").then(fn);
    const registration = bridge.on("theme", fn);
    return {
      ready: initial,
      dispose: Promise.resolve(registration),
    };
  };
  let removeExposurePort = null;
  const port = {
    register: (kind, name) => registry.registered({ surface: surfaceId, kind, name }),
    onRequest: (fn) => {
      removeExposurePort = registerSurfacePort(surfaceId, fn);
      return removeExposurePort;
    },
    reply: (id, payload) => {
      const send = () => bridge.call("exposureReply", { id, ...payload, surface: surfaceId });
      return replyGate === null ? send() : replyGate(surfaceId, send);
    },
    report: (message) => reportRecord("error", message),
    unregister: () => {
      if (removeExposurePort === null) return;
      removeExposurePort();
      removeExposurePort = null;
      registry.unregisterSurface(surfaceId);
    },
  };
  return {
    native: {
      call: invoke,
      on,
    },
    theme,
    call(name, payload, cids) {
      if (name.includes(".")) {
        // default: a command without parameters omits the payload. cids are the correlation identifiers of the cause of the command, and
        // the request carries them only when there are some.
        const params = { name, params: payload ?? {}, surface: surfaceId, ...(cids === undefined ? {} : { cids }) };
        return registry.handle({ method: "command.run", params })
          .then((reply) => reply.error ? Promise.reject(new Error(reply.error.message)) : reply.result);
      }
      // A call that names no command carries no identifiers, so identifiers given to it are refused rather than dropped.
      if (cids !== undefined) throw new TypeError(`surface call ${name} takes no cids: only a command carries them`);
      return invoke(name, payload);
    },
    sidecar(name) {
      // default: sidecars is an optional field of plugin.json, and without it the plugin has no sidecars (docs/spec/plugins.md).
      const declared = surface.sidecars ?? [];
      if (name !== undefined) throw new Error("surface runtime sidecar() takes no argument; it uses the declared sidecar");
      if (declared.length !== 1) throw new Error(`surface runtime requires exactly one declared sidecar, got ${declared.length}`);
      const sidecarName = declared[0];
      const ordered = orderedSidecarPort(sidecarName);
      return {
        send: (id, body, cids) => id === surfaceId
          ? ordered.send(surfaceId, body, cids)
          : Promise.reject(new Error(`surface ${surfaceId} cannot send to sidecar surface ${id}`)),
        on: (id, fn) => on("sidecar-message", (event) => {
          if (event.sidecar === sidecarName && event.surface === id) fn(event.body);
        }),
        onFailure: (id, fn) => id === surfaceId
          ? onSidecarFailure(sidecarName, surfaceId, fn)
          : Promise.reject(new Error(`surface ${surfaceId} cannot observe sidecar surface ${id}`)),
      };
    },
    exposure: createExpose(port, async () => {
      const core = registry.surfaceDeclarations();
      return {
        // default: a kind that the declaration file lacks (status, commands, dom) means the plugin adds no entries of that kind.
        status: [...core.status, ...(declarations.status ?? [])],
        // default: a kind that the declaration file lacks means the plugin adds no entries of that kind.
        commands: [...core.commands, ...(declarations.commands ?? [])],
        // default: a kind that the declaration file lacks means the plugin adds no entries of that kind.
        dom: [...core.dom, ...(declarations.dom ?? [])],
      };
    }),
    // The clipboard bridge payload follows the host contract, which is already typed. In particular,
    // writeText carries a string, not a surface-scoped object.
    clipboard: createClipboardBridge((name, payload) => bridge.call(name, payload), { allowPersist: true }),
    // Opening a link notifies the call observer (watchCalls) like other host requests.
    links: createLinkBridge((name, payload) => tell(name, payload)),
  };
}

/* The function that sends the exposure reply of a surface. Only the diagnostic module of a diagnostic build installs it, to intercept the reply of the surface. */
let replyGate = null;

/**
 * Sends the exposure reply of a surface through fn(surface, send). send() sends the reply to the host and returns the response, and fn
 * returns that result. null removes the installed function.
 */
export function gateSurfaceReplies(fn) {
  replyGate = fn;
}

/* The function that receives calls and their replies. Only the diagnostic module of a diagnostic build installs it. */
let watcher = null;

/**
 * Notifies fn(name, payload, answered) of an application call. answered is the promise of the reply.
 * The report calls that fn sends are not notified.
 */
export function watchCalls(fn) {
  watcher = fn;
}

/** Sends one failure line to the application log. For a document without a host (the browser example), the log is the error level of the console. */
/** Reloads this page after every sent call has its answer (docs/spec/native-host.md#page-reload). */
export const reloadPage = () => bridge.reload();

export const report = (line) => reportRecord("error", line);

/**
 * Sends one observation line to the application log. It is a record that is not a failure (a focus transition, a stored format conversion). A document
 * without a host (the browser example) writes it to the info level of the console. A failure is sent with report.
 */
export const log = (line) => reportRecord("info", line);

/* The application has no console. A failure caught here would not be recorded, so it is not caught.
   The unhandledrejection event of the document forwards it to the application log. */
const tell = (name, payload) => {
  const answered = bridge.call(name, payload);
  if (watcher) watcher(name, payload, answered);
  return answered;
};

/**
 * Sends after the previous call has finished.
 *
 * The calls of a modal must apply in the order they were sent. The call that creates the window is the slowest, and
 * depending on the application each call is processed on a different thread, so without waiting a later call
 * arrives first and tries to move a window that does not exist yet.
 */
let turn = Promise.resolve();
const tellInTurn = (name, payload) => {
  const answered = turn.then(() => tell(name, payload));
  // The next call is sent even when this one fails. Swallowing the failure here would leave no record anywhere, so
  // it is written to the application log.
  turn = answered.catch((why) => reportRecord("error", `host ${name} failed: ${why}`));
  return answered;
};

let last = "";
let themeReply = null;
// Layout preparation and display form one transaction. The native compositor has only one active ticket per window,
// so no next preparation is sent to the host between the two calls.
let layoutTurn = Promise.resolve();
let layoutFrame = layoutTurn;
let layoutResult = layoutTurn;

/**
 * The ordering promise that is fulfilled when layout step step ends. It is fulfilled on failure too, so that a failed transaction does not block the next independent layout.
 * The caller receives that failure as the reply of the place that contains this step and reports it, so it is not written again here (docs/spec/hosts.md#application-log).
 */
const layoutStepEnd = (step) => step.then(() => undefined, () => undefined);
let layoutPresented = false;
/* The window button area and title bar height ({controls, row}) of the most recent preparation whose display the host confirmed. It is committed state, and
   it is null before a display is confirmed (docs/spec/native-surfaces.md#title-bar-height). */
let presentedChrome = null;
const surfacePreparedListeners = new Set();
let lastPreparedSurfaces = [];

/** Registers the workbench lifecycle listener for prepared native surfaces. */
/** Receives the files dropped on the window {urls, x, y} (page coordinates). Without an application there are no dropped files. */
/** Asks through the save panel of the window where to save a new document of its project (docs/spec/plugins.md#pluginjson). */
export function filePlace(name) {
  return tell("filePlace", { name });
}

export function onFilesDropped(listener) {
  if (native) bridge.on("files-dropped", listener);
}

/**
 * The notification center of the operating system (docs/spec/plugins.md#tab-reports). It is null without an application.
 * onState receives {authorization, error}, onPosted receives the notification that the notification center accepted, and onActivated receives the
 * {surface} of the notification that was clicked.
 */
export const notificationCenter = native ? {
  post: (request) => tell("notify", request),
  remove: (request) => tell("notificationRemove", request),
  state: () => tell("notificationState"),
  onState: (listener) => bridge.on("notification-state", listener),
  onPosted: (listener) => bridge.on("notification-posted", listener),
  onActivated: (listener) => bridge.on("notification-activated", listener),
} : null;

/**
 * The host calls of the debug view (docs/spec/debug.md). Null without the application host, which has no logs folder.
 */
export const debug = native ? {
  files: () => tell("debugFiles"),
  record: (page) => tell("debugRecord", { page }),
  save: (request) => tell("debugSave", request),
  saveAll: () => tell("debugSaveAll"),
  saveText: (request) => tell("debugSaveText", request),
  read: (request) => tell("debugRead", request),
  query: (request) => tell("logQuery", request),
  onChanged: (listener) => bridge.on("debug-log-changed", listener),
  onSaveProgress: (listener) => bridge.on("debug-save-progress", listener),
  onSaveDone: (listener) => bridge.on("debug-save-done", listener),
} : null;

export function onSurfacePrepared(listener) {
  if (typeof listener !== "function") throw new TypeError("surface preparation listener must be a function");
  surfacePreparedListeners.add(listener);
  if (lastPreparedSurfaces.length) listener(lastPreparedSurfaces);
  return () => surfacePreparedListeners.delete(listener);
}

/** Validates the window button area and title bar height contained in the reply of a preparation. Check W compares this value with the first row. */
function checkChrome(chrome) {
  const area = chrome?.controls;
  if (!area || ![area.x, area.y, area.w, area.h, chrome.row].every(Number.isFinite) || chrome.row < 0) {
    throw new Error(`the surface preparation answered no window chrome: ${JSON.stringify(chrome)}`);
  }
}

function notifySurfacePrepared(placements) {
  lastPreparedSurfaces = placements;
  for (const listener of surfacePreparedListeners) listener(placements);
}

/**
 * The interface that handles the window itself. It is null without an application.
 *
 * The OS draws the frame of the window. This example does not recreate the corners, shadow, resizing or buttons. Only the title bar is
 * transparent and the content fills the whole window, so the buttons that the window draws are placed over the page. This interface handles
 * that area and the area for dragging.
 */
export const chrome = native ? {
  draggable: (el) => bridge.draggable(el),
  /** The area that the buttons drawn by the window occupy, and the title bar height. For a window that draws no buttons the width is 0. */
  controls: () => tellInTurn("windowControls"),
  /**
   * The {controls, row} of the most recent preparation whose display was confirmed. The preparation carries the title bar height and the host decides it in that transaction,
   * so this is the button area committed to the screen. It is null when no preparation has been confirmed.
   */
  presented: () => presentedChrome,
} : null;

/**
 * The document region reads of the memory saver (docs/spec/hosts.md#memory-pressure): the query {media, capture, form} and
 * the base64 interactionState of the region `document` of `surface`. Without an application there are no regions.
 */
export const documents = native ? {
  query: (surface, document) => bridge.call("documentQuery", { surface, document }),
  interactionState: (surface, document) => bridge.call("documentInteractionState", { surface, document }),
} : null;

/** The surface interface. Without an application it does nothing. */
export const surfaces = native ? {
    /* The plugin kinds that the application draws. Every plugin that has a surface is drawn here, so the registry is that
       list. Writing names here would require editing this file whenever a plugin is added. */
    get kinds() {
      return plugins().map((p) => p.id);
    },

    /** Sends one failure line to the application log. */
    report: (line) => reportRecord("error", line),

    theme(values) {
      themeReply = tellInTurn("setTheme", values);
      return themeReply;
    },

    /** The language of the application menu. The host ignores a repeated send of the same language. */
    menuLanguage: (language) => tellInTurn("setMenuLanguage", language),

    place(record) {
      const surfaces = record.surfaces.map((s) => ({
        id: s.id,
        dim: s.dim,
        plugin: s.surface.pluginId,
        composition: s.surface.composition,
        visible: s.visible,
        ...toPage(s.applied),
        // The start values of the view of a view surface (docs/spec/native-surfaces.md#view-surfaces); a surface of another
        // composition carries none.
        ...(s.start ? { start: s.start } : {}),
      }));

      // place is called on every render, and on every frame while a divider is dragged.
      // A request identical to the previous one is not sent.
      const request = {
        // Whether this is the last update or updates continue. While they continue and the view grows,
        // the area that has not been rendered yet appears white.
        settled: record.settled !== false,
        // The image raster must commit after the DOM frame of the page. Other
        // surfaces can commit consecutive frames immediately.
        waitForPresentation: record.surfaces.some(({ surface, visible }) =>
          visible === true && surface?.composition?.kind === "view" &&
          surface.composition.regions?.some(({ kind }) => kind === "image") === true),
        overlays: windowOverlays(),
        surfaces,
        // The height (pt) of the first row that the next drawing will show. The host sets the window title bar to this height in the transaction of this preparation.
        titlebar: record.titlebar,
      };
      const key = JSON.stringify(request);
      if (key !== last) {
        last = key;
        // layoutTurn is the transaction order of surface preparation and display.
        // It does not also wait for the global command turn: doing so would let an unrelated
        // host call add one frame per divider step.
        const hasView = record.surfaces.some(({ surface }) => surface?.composition?.kind === "view");
        const scheduled = layoutTurn.then(async () => {
          if (hasView) {
            const { waitSurfaceCompositionDeclared } = await import("./surface-modules.js");
            await Promise.all(record.surfaces
              .filter(({ surface }) => surface?.composition?.kind === "view")
              .map(({ id }) => waitSurfaceCompositionDeclared(id)));
            let reply;
            do {
              reply = themeReply;
              if (!reply) throw new Error("view placement has no host theme reply");
              await reply;
            } while (reply !== themeReply);
          }
          return tell("syncSurfaces", request);
        });
        layoutFrame = scheduled;
        layoutResult = scheduled.then((frame) => {
          checkChrome(frame.chrome);
          notifySurfacePrepared(frame.placements);
          return frame.placements;
        });
        layoutPresented = false;
        layoutTurn = layoutStepEnd(scheduled);
      }
      if (record.drawn && !layoutPresented) {
        const preparedLayout = layoutFrame;
        const presentedLayout = preparedLayout.then((frame) =>
          tell("presentSurfaces", {
            ticket: frame.ticket,
            placements: frame.placements,
            settled: request.settled,
            waitForPresentation: request.waitForPresentation,
          }).then((placed) => {
            presentedChrome = frame.chrome;
            return placed;
          }));
        layoutResult = presentedLayout;
        layoutPresented = true;
        layoutTurn = layoutStepEnd(presentedLayout);
      }
      // Handles the synchronization and the display call together so that a new synchronization does not replace the native ticket
      // before the previous ticket is committed.
      const result = layoutResult;
      return result.then((placed) =>
        placed.map((p) => ({ id: p.id, visible: p.visible, ...toPlane(p) }))).catch((error) => {
          if (result === layoutResult) { last = ""; layoutPresented = false; }
          throw error;
        });
    },
    // Call it after the surface placement RPC has ended so that the page can keep handling native raster events.
    waitPresented: () => tell("waitPresented"),
    /**
     * Forgets the last sent request so that the next placement is sent even when it equals that request. The page calls it when the state of the window changed without a request
     * (when AppKit restored the title bar of a window that left full screen).
     */
    forget() {
      last = "";
    },
} : {
  kinds: [],
  // A failure of a document without a host is written to the error level of the console (docs/spec/plugins.md).
  report: (line) => console.error(line),
  theme: () => {},
  menuLanguage: () => {},
  // Without a host, the place where this document seats the surface is the actual place. The compositor records that reply.
  place: (record) => record.surfaces.map((s) => ({ id: s.id, ...s.applied })),
  waitPresented: async () => null,
  forget: () => {},
};

let pick = null;
let shown = null;

/* The state that the open modal document reported last. It is core.modal of docs/spec/exposure.md. */
let modalDocument = null;
const modalListeners = new Set();
const modalChanged = () => { for (const fn of modalListeners) fn(); };

/** The open modal and the state its document reported. It is null when no modal is open. */
export function modalState() {
  if (!shown) return null;
  const el = document.getElementById(shown);
  if (!el) throw new Error(`the shown modal ${shown} is not in the document`);
  return { id: shown, mode: el.dataset.nativeModal, document: modalDocument };
}

/** Calls fn when the modal state changes. Returns an unsubscribe function. */
export function onModalState(fn) {
  modalListeners.add(fn);
  return () => modalListeners.delete(fn);
}

/* The receiver of input that the application sends to the page. The plane registers it. */
let onPress = () => {};
let onInput = () => {};

/**
 * Registers the function that receives input from the application.
 *
 *   press(id)   A press on a surface. A surface is a native view, so a click on it does not
 *               reach this document. The application passes the surface id.
 *               input(step) Press, move and release of the left button. The coordinates belong to this document. The grab area of a divider
 *               is wider than the gap, so when the gap is one line wide, that whole area lies
 *               below the surface.
 */
/* The command that the host application menu asked this window to run. */
let onMenu = () => {};

/** Registers the function to call when an application menu item sends a command name. */
export function onMenuCommand(fn) {
  onMenu = fn;
}

/* The receiver of the memory pressure reports {level, seq} of the host (docs/spec/hosts.md#memory-pressure). */
let onPressure = () => {};

/** Registers the function to call with each memory pressure report of the host. */
export function onMemoryPressure(fn) {
  onPressure = fn;
}

let onDocumentStateChange = () => {};
/** Receives each document state {surface, document, state} that a document region of any surface reports. */
export function onDocumentState(fn) {
  onDocumentStateChange = fn;
}

export function onSurfaceInput({ press, input }) {
  onPress = press;
  onInput = input;
}

if (native) {
  bridge.on("surface-pressed", (id) => onPress(id));
  bridge.on("menu-command", (message) => onMenu(message?.name));
  bridge.on("memory-pressure", (report) => onPressure(report));
  bridge.on("document-state", (event) => onDocumentStateChange(event));
  bridge.on("surface-input", (step) => onInput(step));
  // A modal replies several times, so the subscription is not released here but in hide.
  // The reply carries the modal it belongs to. It is used to filter out the last reply of a closed modal so that it
  // does not reach the receiver of the next modal.
  bridge.on("overlay-pick", ({ id, key, value }) => {
    if (id !== shown) {
      // default: a page that shows no modal records the empty text as the shown one.
      emitEvent("info", "page.overlay.dropped", { id, shown: shown ?? "", key });
      return;
    }
    // The state report of a modal document is not a response. It is not forwarded to the receiver of the element.
    if (key === "document") {
      modalDocument = JSON.parse(value);
      modalChanged();
      return;
    }
    if (!pick) {
      emitEvent("info", "page.overlay.dropped", { id, shown: "", key });
      return;
    }
    // The answer is traced at its receipt: the overlay document has no trace switch, so the page writes this event for it
    // (docs/spec/performance-trace.md#producers).
    trace("modal.answer", { key });
    pick(key, value);
  });
}

/* A shape drawn over a surface. It is one native view and not a web view: its fill and line have alpha and are
   composited over what the surface shows. A web view cannot do this because WebKit paints its own
   background. */
export const shapes = native ? {
    set(id, rect, style) {
      tellInTurn("setShape", {
        id,
        rect: toPage(rect),
        radius: style.radius,
        lineWidth: style.lineWidth,
        fill: rgba(style.fill),
        line: rgba(style.line),
      });
    },

    clear: (id) => tellInTurn("clearShape", id),
} : {
  set: () => {},
  clear: () => {},
};

/**
 * A modal drawn over a surface. The application receives the whole element and draws it in its own window.
 *
 * conceal is the way to hide the element of this document. It differs per element, so the caller supplies it.
 * Without an application the element is not hidden and this document draws it as it is.
 */
export const overlay = native ? {
    show(el, rect, onPick) {
      // This interface shows one modal at a time. If the one on display is not closed, its window stays
      // in the application and nothing refers to it.
      if (shown) this.hide();
      pick = onPick;
      // The elements that arrive this way are [data-native-modal]. If only the marker is placed and not checked,
      // the markup and the behavior diverge, and an element without the marker silently gets a view.
      if (!["dialog", "menu"].includes(el.dataset.nativeModal)) {
        throw new Error(`${el.id || el.className} needs data-native-modal="dialog" or "menu"`);
      }
      // The view name is the element id. Two elements without an id share the same view.
      if (!el.id) throw new Error("a [data-native-modal] element needs an id");
      // The name by which assistive technology announces the overlay.
      const name = el.getAttribute("aria-label");
      if (!name) throw new Error(`${el.id} needs an aria-label to name its overlay`);
      shown = el.id;
      modalDocument = null;
      modalChanged();
      const style = getComputedStyle(el);
      tellInTurn("overlayShow", {
        id: shown,
        title: name,
        rect: overlayFrame(el, rect),
        ...drawing(el),
        radius: el.dataset.nativeModal === "dialog" ? 0 : parseFloat(style.borderTopLeftRadius),
      });
    },

    /**
     * Updates the position of the modal view of this element. The page decides the position.
     *
     * Does nothing when the one on display is not this element. This interface shows one at a
     * time, and a caller that moves or closes a window that is not its own touches the window of
     * another feature.
     */
    place(el, rect) {
      if (shown !== el.id) return;
      tellInTurn("overlayPlace", { id: shown, rect: overlayFrame(el, rect), card: cardFrame(el) });
    },

    /** Replaces the content of the modal view of this element. Recreating the view flickers. */
    update(el) {
      if (shown !== el.id) return;
      tellInTurn("overlayUpdate", { id: shown, ...drawing(el) });
    },

    /** Closes the modal view of this element. */
    hide(el) {
      if (el && shown !== el.id) return;
      const id = shown;
      shown = null;
      pick = null;
      modalDocument = null;
      modalChanged();
      if (id) tellInTurn("overlayHide", id);
    },
} : {
  show: () => {},
  place: () => {},
  update: () => {},
  hide: () => {},
};
