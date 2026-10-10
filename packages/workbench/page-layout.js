// Error display and layout wiring of the main document (index.html). The layout queue shows the plane layout, the first row of
// a window without a plane, and the empty plane of a project switch one at a time, and receives their failures as error
// displays. The project switch and the core command that wait for such a layout do not report the same failure again
// (docs/spec/hosts.md#application-log). The caller passes the document, host, plane and compositor.
import { createLayoutQueue, drawPrepared, nextTask } from "./layout-queue.js";
import { frameLayout } from "./frame-text.js";
import { trace } from "./performance.js";
import { showError as showShownError } from "./shown-errors.js";

/**
 * Creates the function that shows an error in the error banner of the main document. It logs the error at the moment it
 * appears (shown-errors.js). If the banner does not exist, it creates the banner after the header.
 *
 *   document  main document
 *   changed   reports that the core state changed (coreChanged of core-exposure.js)
 */
export function createErrorDisplay({ document, changed }) {
  return function showError(reason, detail = "") {
    let el = document.getElementById("applicationError");
    if (!el) {
      el = document.createElement("div");
      el.id = "applicationError";
      el.setAttribute("role", "alert");
      document.querySelector("header").after(el);
    }
    showShownError(el, "page", String(reason), detail);
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
  target.addEventListener("error", (e) => showError(e.message, ` @ ${e.filename}:${e.lineno}`));
  target.addEventListener("unhandledrejection", (e) => {
    // default: a rejection value that is not an Error has no stack.
    const stack = e.reason instanceof Error && e.reason.stack ? `\n${e.reason.stack}` : "";
    showError(e.reason instanceof Error ? e.reason.message : e.reason, stack);
  });
}

/**
 * Creates the layout queue of the main document and the functions that schedule and wait for its layouts.
 *
 *   document   main document that reads the slots
 *   showError  function of createErrorDisplay
 *   setVerify, log  receive the verification row and the observation line (core-exposure.js, host.js)
 *   surfaces   surface interface of the host (surfaces of host.js); uses waitPresented
 *   plane      { currentGrid, settle, clear }(plane.js)
 *   compositor { publishAhead, publish }(compositor.js)
 *   textSize   frame scale of the current setting
 *   rendered   promise of the presentation that the last render committed (onRender of index.html)
 *   waitSurfaceCompositionDeclared  waits for the composition declaration of the surface modules (surface-modules.js)
 */
export function createPageLayout({
  document, showError, setVerify, log, surfaces, plane, compositor, textSize, rendered, waitSurfaceCompositionDeclared,
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
      showError(`surface presentation failed: ${message}`);
      setVerify([{ name: "Surface presentation", ok: false, note: message }]);
    },
    superseded() {
      supersededLayouts++;
    },
  });
  let layoutEpoch = 0;
  /* Layout number of the performance trace. While the trace is on, each layout records the times (performance.now, ms) of the wait,
     the prepare reply, before and after the DOM draw, the animation frame and the presentation, so the stage that delays the layout on screen can be identified. */
  let layoutTraceId = 0;

  return {
    /** Error of the last layout that failed. clearFailure removes it when a later render is presented. */
    failure: () => failure,
    clearFailure() {
      failure = null;
    },
    /** Writes the number of replaced layouts as one line and resets the count. */
    reportSuperseded() {
      if (supersededLayouts === 0) return;
      log(`layout: ${supersededLayouts} waiting layouts were replaced by newer layouts before presentation`);
      supersededLayouts = 0;
    },
    /** Waits for the presentation of the layout that a project switch loaded (onSwitch of projects.js). */
    async presented() {
      // If the loaded layout fails, failed of the queue has already shown the failure. It does not wait for the presentation of a layout that is not presented.
      if (!(await layouts.wait())) return;
      // `draw()` returns before the onRender commit finishes. While the latest native layout
      // is pending, the project command is not complete.
      await rendered();
      await surfaces.waitPresented();
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
        factor: textSize(), publishAhead: compositor.publishAhead, publish: compositor.publish,
        frame: nextTask, clearPlane: plane.clear, show,
      });
      layouts.run(() => drawPrepared({ epoch, current: () => layoutEpoch, ...layout }));
      // If the layout that cleared the plane fails, failed of the queue has already shown the failure.
      await layouts.wait();
    },
    /** Schedules the layout that the plane produced (receiver of onLayout of plane.js). */
    onLayout(made, draw, seated, titlebar) {
      const epoch = layoutEpoch;
      const id = ++layoutTraceId;
      const mark = (phase) => trace("layout", { phase, id, t: performance.now() });
      mark("queued");
      layouts.run(() => drawPrepared({
        epoch, current: () => layoutEpoch,
        prepare: async () => {
          mark("prepare");
          const result = await compositor.publishAhead(made, seated, titlebar);
          mark("prepared");
          return result;
        },
        draw: () => { mark("draw"); draw(); mark("drawn"); },
        frame: async (work) => { await nextTask(work); mark("frame"); },
        presented: async () => { await rendered(); mark("presented"); },
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
        factor: textSize(), publishAhead: compositor.publishAhead, publish: compositor.publish, frame: nextTask,
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
      const ids = [...document.querySelectorAll("[data-native-surface-id]")]
        .map((slot) => slot.dataset.nativeSurfaceId);
      await Promise.all(ids.map((id) => waitSurfaceCompositionDeclared(id)));
    },
  };
}
