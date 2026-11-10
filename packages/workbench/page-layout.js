// Error display and layout wiring of the main document (index.html). The layout queue shows the plane layout, the first row of
// a window without a plane, and the empty plane of a project switch one at a time, and receives their failures as error
// displays. The project switch and the core command that wait for such a layout do not report the same failure again
// (docs/spec/hosts.md#application-log). The caller passes the document, host, plane and compositor.
import { createLayoutQueue, drawPrepared, nextTask } from "./layout-queue.js";
import { frameLayout } from "./frame-text.js";
import { trace } from "./performance.js";
import { hideError, showError as showShownError } from "./shown-errors.js";

/**
 * Returns the rows that core.verify holds for the current state. rows() runs the verification of the drawn plane and is
 * called only when drawn is true; without a drawn plane nothing is verified and the rows are empty. failure is the error
 * of the last layout that failed (pageLayout.failure()), and its row is added in both cases.
 */
export function verificationRows({ drawn, rows, failure }) {
  const out = drawn ? rows() : [];
  if (failure) out.push({ name: "Surface presentation", ok: false, note: failure.message });
  return out;
}

/**
 * Creates the function that shows an error in the error banner of the main document. It logs the error at the moment it
 * appears (shown-errors.js). If the banner does not exist, it creates the banner after the header.
 *
 *   document  main document
 *   changed   reports that the core state changed (coreChanged of core-exposure.js)
 */
export function createErrorDisplay({ document, changed }) {
  return function showError(reason, detail = "", source = "") {
    let el = document.getElementById("applicationError");
    if (!el) {
      el = document.createElement("div");
      el.id = "applicationError";
      el.setAttribute("role", "alert");
      document.querySelector("header").after(el);
    }
    el.dataset.errorSource = source;
    showShownError(el, "workbench", String(reason), detail);
    changed();
  };
}

/** The source of the error of a layout that failed, which the presentation of every surface after a later render withdraws. */
const LAYOUT_SOURCE = "layout";

/**
 * Creates the function that withdraws the error of the banner when source showed it. An error that another source showed since then
 * stays. The record of the error stays in the log.
 */
export function createErrorWithdrawal({ document, changed }) {
  return function withdrawError(source) {
    const el = document.getElementById("applicationError");
    if (!el || el.dataset.errorSource !== source) return;
    hideError(el, "workbench");
    el.remove();
    changed();
  };
}

/**
 * Shows an unhandled error and sends it to the application log. The application has no console. The location and stack stay only in the log.
 *
 *   target     window that receives the error and unhandledrejection events
 *   showError  function of createErrorDisplay
 */
export function reportUncaught(target, showError) {
  // default: an error event without a source file (a dispatched error or a cross-origin script) has no location, so the detail adds none.
  target.addEventListener("error", (e) => showError(e.message, e.filename ? ` @ ${e.filename}:${e.lineno}` : ""));
  target.addEventListener("unhandledrejection", (e) => {
    // default: a rejection value that is not an Error has no stack.
    const stack = e.reason instanceof Error && e.reason.stack ? `\n${e.reason.stack}` : "";
    showError(e.reason instanceof Error ? e.reason.message : e.reason, stack);
  });
}

/* The diagnostic fault of the next layout draw (diagnostics.layout.fail in docs/spec/endpoint.md). A check arms it, and the next draw of
   a layout throws it once, so the check observes how the page handles a draw that throws. */
let layoutFault = false;

/** Arms the diagnostic fault: the next layout draw throws `diagnostic layout fault`. */
export function armLayoutFault() {
  layoutFault = true;
}

/* Waits for the newest layout of the page that createPageLayout made last (diagnostics.drag in docs/spec/endpoint.md). */
let newestLayout = async () => {};

/**
 * The workbench method that the host asks before it waits for the presentation of the window (host.window.presented and
 * diagnostics.drag): a layout that waits behind a running one is known only to the page
 * (exposure.window-presented.waits-for-the-last-placement in docs/spec/host-contract.md).
 */
export const PLACEMENT_LAST = "workbench.placement.last";

/** Answers null when the newest layout ran to the end. It fails with the failure of that layout. */
export async function placementLast() {
  await newestLayout();
  return null;
}

/**
 * Creates the layout queue of the main document and the functions that schedule and wait for its layouts.
 *
 *   document   main document that reads the slots
 *   showError  function of createErrorDisplay
 *   withdrawError  function of createErrorWithdrawal
 *   setVerify, log  receive the verification row and the observation line (core-exposure.js, host.js)
 *   surfaces   surface interface of the host (surfaces of host.js); uses waitPresented
 *   plane      { currentGrid, settle, clear }(plane.js)
 *   compositor { publishAhead, publish, cancelPrepared }(compositor.js)
 *   textSize   frame scale of the current setting
 *   rendered   promise of the presentation that the last render committed (onRender of index.html)
 *   waitSurfaceCompositionAnswered  waits until the composition of a surface is answered for a command (surface-modules.js)
 *   surfaceUnloaded  whether the memory saver holds the surface unloaded (memory-saver.js), so that no mount declares its composition
 */
export function createPageLayout({
  document, showError, withdrawError, setVerify, log, surfaces, plane, compositor, textSize, rendered, waitSurfaceCompositionAnswered, surfaceUnloaded,
}) {
  let failure = null;
  /* Number of layouts replaced by a newer layout before they were presented. It is written as one line to the application log
     when the motion has stopped. Calling the host for each layout during the motion delays the presentation by that much. */
  let supersededLayouts = 0;
  const layouts = createLayoutQueue({
    failed(error) {
      failure = error;
      // default: a rejection that is not an Error is shown as its own value converted to a string.
      const message = String(error?.message ?? error);
      console.error(`surface presentation failed: ${message}`);
      failureShown = true;
      showError(`surface presentation failed: ${message}`, "", LAYOUT_SOURCE);
      setVerify([{ name: "Surface presentation", ok: false, note: message }]);
    },
    superseded() {
      supersededLayouts++;
    },
  });
  // Whether the banner may show the failure of a layout, and whether the wait that withdraws it runs.
  let failureShown = false;
  let withdrawing = false;
  let layoutEpoch = 0;
  /* Layout number of the performance trace. While the trace is on, each layout records the times (performance.now, ms) of the wait,
     the prepare reply, before and after the DOM draw, the animation frame and the presentation, so the stage that delays the layout on screen can be identified. */
  let layoutTraceId = 0;
  newestLayout = async () => {
    if (!(await layouts.wait())) throw failure;
  };

  /**
   * Withdraws the error of a failed layout after a later render, once every surface has presented. The failure names a surface that did
   * not present, which the presentation of another render does not end. A layout that fails during the wait keeps its failure, and the
   * presentation after it asks again.
   */
  function withdrawWhenPresented() {
    if (!failureShown || withdrawing) return;
    withdrawing = true;
    surfaces.waitPresented().then(() => {
      withdrawing = false;
      if (failure !== null) return;
      failureShown = false;
      withdrawError(LAYOUT_SOURCE);
    }, () => {
      // A wait that ends without the presentation asks nothing again: the next presented render asks again (clearFailure).
      withdrawing = false;
    });
  }

  return {
    /** Error of the last layout that failed. clearFailure removes it when a later render is presented, and its banner when every surface has. */
    failure: () => failure,
    clearFailure() {
      failure = null;
      withdrawWhenPresented();
    },
    /** Writes the number of replaced layouts as one line and resets the count. */
    reportSuperseded() {
      if (supersededLayouts === 0) return;
      log(`layout: ${supersededLayouts} waiting layouts were replaced by newer layouts before presentation`);
      supersededLayouts = 0;
    },
    /** Waits for the loaded layout; returns false when the layout queue reports failure. */
    async presented() {
      // If the loaded layout fails, failed of the queue has already shown the failure. It does not wait for the presentation of a layout that is not presented.
      if (!(await layouts.wait())) return false;
      // `draw()` returns before the onRender commit finishes. While the latest native layout
      // is pending, the project command is not complete.
      await rendered();
      await surfaces.waitPresented();
      return true;
    },
    /**
     * A project switch clears the plane (onSwitch of projects.js). The draw that clears the plane draws the library screen with show. That
     * draw runs in the animation frame that runs before the observation round, so the screen switch that hides the workspace does not change
     * the size of an element observed inside the round (F43).
     */
    async empty(show) {
      // The switch cancels the draw of the plane prepared before it. That draw may have used the new frame scale, so the draw
      // that clears the plane uses the current scale and includes its first row in the preparation (docs/spec/native-surfaces.md#title-bar-height).
      const epoch = ++layoutEpoch;
      const layout = frameLayout({
        factor: textSize(), publishAhead: compositor.publishAhead, publish: compositor.publish, cancelPrepared: compositor.cancelPrepared,
        frame: nextTask, clearPlane: plane.clear, show,
      });
      layouts.run(() => drawPrepared({ epoch, current: () => layoutEpoch, ...layout }));
      // If the layout that cleared the plane fails, failed of the queue has already shown the failure.
      await layouts.wait();
    },
    /**
     * Schedules the layout that the plane produced (receiver of onLayout of plane.js). held tells whether the seats of the layout still
     * name what the cards show; a layout whose seats moved does not draw and hands its preparation to the next layout (drawPrepared).
     */
    onLayout(made, draw, seated, titlebar, held) {
      if (typeof held !== "function") throw new TypeError("a layout of the plane needs held, the check of its seats");
      const epoch = layoutEpoch;
      const id = ++layoutTraceId;
      const mark = (phase) => trace("layout", { phase, id, t: performance.now() });
      mark("queued");
      layouts.run(() => drawPrepared({
        epoch, current: () => layoutEpoch, held,
        prepare: async () => {
          mark("prepare");
          const result = await compositor.publishAhead(made, seated, titlebar);
          mark("prepared");
          return result;
        },
        draw: () => {
          mark("draw");
          if (layoutFault) {
            layoutFault = false;
            throw new Error("diagnostic layout fault");
          }
          draw();
          mark("drawn");
        },
        frame: async (work) => { await nextTask(work); mark("frame"); },
        presented: async () => { await rendered(); mark("presented"); },
        cancel: async (options) => { await compositor.cancelPrepared(options); mark("cancelled"); },
      }));
    },
    /**
     * Draws the first row with the prepared layout. If a plane exists, it redraws the plane. A window without a plane (library) applies the
     * current frame scale of the setting after a preparation that carries the height of the first row without a surface. The preparation sets the window title bar in the same transaction,
     * so the row and the button change in the same frame (docs/spec/native-surfaces.md#title-bar-height).
     */
    drawFrame() {
      if (plane.currentGrid()) {
        plane.settle();
        return;
      }
      const epoch = layoutEpoch;
      const layout = frameLayout({
        factor: textSize(), publishAhead: compositor.publishAhead, publish: compositor.publish, cancelPrepared: compositor.cancelPrepared, frame: nextTask,
      });
      layouts.run(() => drawPrepared({ epoch, current: () => layoutEpoch, ...layout }));
    },
    /**
     * Draw order of the plane. A core command that changed the layout replies after waiting for it. The slots are read after the newest layout is drawn,
     * so no slot remains for a surface that this command or a later command released (docs/spec/exposure.md#registration).
     */
    async drawn() {
      // If the newest layout fails, failed of the queue has already shown the failure. It does not wait for the slot of a layout that is not presented.
      if (!(await layouts.wait())) return;
      // A hidden section keeps its slot while it is unloaded, and no mount of it will declare a composition.
      const ids = [...document.querySelectorAll("[data-native-surface-id]")]
        .map((slot) => slot.dataset.nativeSurfaceId)
        .filter((id) => !surfaceUnloaded(id));
      // A view that has not declared its composition has an empty place in the drawn layout, so no answer waits for its declaration
      // (docs/spec/exposure.md#registration); a declaration in flight is answered by the host in its own step.
      await Promise.all(ids.map((id) => waitSurfaceCompositionAnswered(id)));
    },
  };
}
