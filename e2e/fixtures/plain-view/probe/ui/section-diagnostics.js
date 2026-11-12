// The diagnostic module of the section view of the plain view probe, which diagnostics.json declares and a diagnostic build loads
// (docs/spec/plugins.md#diagnostic-declarations). The section view serves the entries of the section-view contract on its own surface
// (docs/spec/plugin-processes.md#section-views):
//   probeplain.view.frames {action}  start observes the content frames of the view document and answers {enabled: true, sourceClock};
//                                    stop ends the observation and answers {enabled: false}
//   probeplain.view.history          answers {length}, the number of entries of the session history of the view document
//   probeplain.section.view.ready    the status {ready, content} of the view: ready while the view shows the declared content
import { observeViewDocumentFrames } from "@soksak/plugin-api/diagnostic-view-frames";

/** The one string that the enum of the field `field` of the status `status` of `declaration` declares; another declaration is an error. */
export function declaredText(declaration, status, field) {
  const values = declaration?.exposes?.status?.find((entry) => entry.name === status)?.schema?.properties?.[field]?.enum;
  if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== "string") {
    throw new Error(`the diagnostic declaration of the probeplain section view gives ${status} no ${field} enum of one string`);
  }
  return values[0];
}

/**
 * Serves the section-view entries of the section view.
 *
 *   declaration     the diagnostic declaration of the start values, which declares the content of the status
 *   status          the name of the ready status of the view
 *   registerStatus  registers that status on the exposure of the page, with its read and its subscribe
 *   commands        the command registration of the view bridge
 *   view            the window of the view document
 *   content         the element of the view that shows the declared content
 *   log             the log of the view runtime, which records the content frames as plugin.probeplain.view.content_frame
 */
export async function attach({ declaration, status, registerStatus, commands, view, content, log }) {
  const text = declaredText(declaration, status, "content");
  const document = view.document;
  // The stop of the observation of the frames while probeplain.view.frames is started, or null.
  let started = null;

  const start = () => {
    if (started !== null) throw new Error("probeplain.view.frames is already started");
    const stop = observeViewDocumentFrames({
      document,
      log,
      ResizeObserver: view.ResizeObserver,
      requestAnimationFrame: view.requestAnimationFrame.bind(view),
      cancelAnimationFrame: view.cancelAnimationFrame.bind(view),
      now: view.performance.now.bind(view.performance),
      timeOriginMs: view.performance.timeOrigin,
    });
    started = stop;
    const sourceClock = { documentTimeOriginMs: view.performance.timeOrigin, sourceNowMs: view.performance.now(), sourceResolutionMs: 1 };
    return { enabled: true, sourceClock };
  };

  const stop = () => {
    if (started === null) throw new Error("probeplain.view.frames is not started");
    const stopFrames = started;
    started = null;
    stopFrames();
    return { enabled: false };
  };

  // The element is read at each value, so a view that no longer shows the declared text reports ready false.
  const ready = () => ({ ready: content.isConnected && !content.hidden && content.textContent === text, content: text });

  await Promise.all([
    registerStatus(ready, (listener) => {
      const observer = new view.MutationObserver(() => listener(ready()));
      observer.observe(content, { attributes: true, attributeFilter: ["hidden"], characterData: true, childList: true, subtree: true });
      return () => observer.disconnect();
    }),
    commands.register("probeplain.view.frames", async ({ action } = {}) => {
      if (action === "start") return start();
      if (action === "stop") return stop();
      throw new TypeError("probeplain.view.frames action must be start or stop");
    }),
    commands.register("probeplain.view.history", async () => {
      const length = view.history.length;
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new Error(`probeplain.view.history read an invalid session history length ${JSON.stringify(length)}`);
      }
      return { length };
    }),
  ]);
}
