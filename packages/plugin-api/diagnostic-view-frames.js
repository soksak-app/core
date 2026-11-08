// Diagnostic observation of the view document's content-size update after ResizeObserver and the next animation frame.

/**
 * Observes the actual view document root for one explicitly started diagnostic run.
 * The record describes the root size available after the next animation frame; it does not claim physical display presentation.
 *
 *     document              the view document whose documentElement is the content viewport
 *     log                   the view's runtime logger
 *     ResizeObserver        the ResizeObserver constructor of the view document
 *     requestAnimationFrame the requestAnimationFrame of the view document
 *     cancelAnimationFrame  the cancelAnimationFrame of the view document
 *     now                   performance.now of the view document
 *     timeOriginMs          performance.timeOrigin of the view document
 *
 * Returns a stop function that disconnects the observer and cancels the pending animation frame, if any.
 */
export function observeViewDocumentFrames({ document, log, ResizeObserver, requestAnimationFrame, cancelAnimationFrame,
  now, timeOriginMs }) {
  const root = document?.documentElement;
  if (!root || typeof root.getBoundingClientRect !== "function") {
    throw new TypeError("view frame observation requires a view document with documentElement");
  }
  if (typeof log?.trace !== "function") throw new TypeError("view frame observation requires runtime.log.trace");
  if (typeof ResizeObserver !== "function") throw new TypeError("view frame observation requires ResizeObserver");
  if (typeof requestAnimationFrame !== "function") throw new TypeError("view frame observation requires requestAnimationFrame");
  if (typeof cancelAnimationFrame !== "function") throw new TypeError("view frame observation requires cancelAnimationFrame");
  if (typeof now !== "function") throw new TypeError("view frame observation requires performance.now");
  if (!Number.isFinite(timeOriginMs) || timeOriginMs < 0) {
    throw new TypeError("view frame observation requires a finite document time origin");
  }

  let stopped = false;
  let sequence = 0;
  let pendingObserveFrame = null;
  let pendingFrame = null;
  const observer = new ResizeObserver((entries) => {
    if (stopped) return;
    if (!Array.isArray(entries) || !entries.some((entry) => entry?.target === root)) {
      throw new Error("view frame ResizeObserver did not report documentElement");
    }
    const resizeAtMs = now();
    if (!Number.isFinite(resizeAtMs) || resizeAtMs < 0) {
      throw new Error("view frame ResizeObserver has no finite source timestamp");
    }
    if (pendingFrame !== null) {
      if (resizeAtMs < pendingFrame.resizeAtMs) {
        throw new Error("view frame ResizeObserver timestamp moved backwards");
      }
      if (!Number.isSafeInteger(pendingFrame.resizeCount + 1)) {
        throw new Error("view frame ResizeObserver delivery count exceeded the safe integer range");
      }
      pendingFrame.resizeAtMs = resizeAtMs;
      pendingFrame.resizeCount += 1;
      return;
    }
    const frame = { id: null, firstResizeAtMs: resizeAtMs, resizeAtMs, resizeCount: 1 };
    pendingFrame = frame;
    try {
      frame.id = requestAnimationFrame((frameTimeMs) => {
        if (pendingFrame === frame) pendingFrame = null;
        if (stopped) return;
        if (!Number.isFinite(frameTimeMs) || frameTimeMs < 0) {
          throw new Error("view frame animation callback has no finite timestamp");
        }
        if (frameTimeMs < frame.resizeAtMs) throw new Error("view frame animation timestamp precedes ResizeObserver time");
        const rect = root.getBoundingClientRect();
        if (!Number.isFinite(rect.width) || rect.width < 0 || !Number.isFinite(rect.height) || rect.height < 0) {
          throw new Error("view frame documentElement has invalid dimensions");
        }
        log.trace("view.content_frame", {
          sequence: sequence++, width: rect.width, height: rect.height,
          documentTimeOriginMs: timeOriginMs, firstResizeAtMs: frame.firstResizeAtMs,
          resizeAtMs: frame.resizeAtMs, resizeCount: frame.resizeCount, frameTimeMs,
        });
      });
    } catch (error) {
      if (pendingFrame === frame) pendingFrame = null;
      throw error;
    }
    if (!Number.isInteger(frame.id)) {
      if (pendingFrame === frame) pendingFrame = null;
      throw new Error("requestAnimationFrame returned an invalid frame identifier");
    }
  });
  pendingObserveFrame = requestAnimationFrame(() => {
    pendingObserveFrame = null;
    if (!stopped) observer.observe(root, { box: "content-box" });
  });
  if (!Number.isInteger(pendingObserveFrame)) throw new Error("requestAnimationFrame returned an invalid frame identifier");

  return () => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    if (pendingObserveFrame !== null) {
      cancelAnimationFrame(pendingObserveFrame);
      pendingObserveFrame = null;
    }
    if (pendingFrame !== null) {
      cancelAnimationFrame(pendingFrame.id);
      pendingFrame = null;
    }
  };
}
