// Diagnostic observation of the view document's content-size update after ResizeObserver and the next animation frame.

/** A plugin-owned WebKit DOM renderer reference. Native snapshotting owns the
 * pixels; this provider owns the actual visible text/layout and its lease. */
export function createRenderedDocumentReferenceProvider({ root, provider, view = root?.ownerDocument?.defaultView }) {
  const document = root?.ownerDocument;
  if (!root || typeof root.getBoundingClientRect !== "function" || !document?.createTreeWalker
    || !document?.createRange || !document.fonts?.ready || typeof view?.requestAnimationFrame !== "function"
    || typeof view?.cancelAnimationFrame !== "function" || typeof view?.MutationObserver !== "function"
    || typeof view?.ResizeObserver !== "function" || typeof provider !== "string" || provider === "") {
    throw new TypeError("rendered document reference requires an actual renderer root, fonts, observers and animation-frame owner");
  }
  let disposed = false;
  let revision = 1;
  let lease = null;
  let pendingFrame = null;
  let rejectFrame = null;
  const changed = () => { revision++; };
  const mutations = new view.MutationObserver(changed);
  const resize = new view.ResizeObserver(changed);
  mutations.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
  resize.observe(root);
  document.fonts.addEventListener("loading", changed);
  document.fonts.addEventListener("loadingdone", changed);
  document.fonts.addEventListener("loadingerror", changed);
  const params = (value, allowed) => {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError("rendered reference has undeclared parameters, including expected text");
    if (!Number.isSafeInteger(value.requestId) || value.requestId <= 0) throw new TypeError("rendered reference requestId must be positive");
  };
  const rectangle = rect => {
    const result = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    if (!Object.values(result).every(Number.isFinite)) throw new Error("actual renderer reference geometry is invalid");
    return result;
  };
  const read = () => {
    if (disposed || !root.isConnected) throw new Error("rendered reference root is disposed or disconnected");
    if (mutations.takeRecords().length) revision++;
    const runs = [];
    const walker = document.createTreeWalker(root, view.NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      const parent = node.parentElement;
      if (!parent) continue;
      const style = view.getComputedStyle(parent);
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) continue;
      const text = node.textContent;
      if (typeof text !== "string" || !text.trim()) continue;
      const range = document.createRange();
      const glyphs = [];
      for (const { segment: grapheme, index } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
        range.setStart(node, index);
        range.setEnd(node, index + grapheme.length);
        const rect = rectangle(range.getBoundingClientRect());
        if (rect.width <= 0 || rect.height <= 0) continue;
        glyphs.push({ grapheme, rect });
      }
      range.detach();
      if (glyphs.length) runs.push({ text: glyphs.map(glyph => glyph.grapheme).join(""), glyphs,
        foreground: style.color, background: style.backgroundColor,
        font: { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, style: style.fontStyle } });
    }
    return { rect: rectangle(root.getBoundingClientRect()), glyphRuns: runs,
      viewport: { width: view.innerWidth, height: view.innerHeight } };
  };
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  return Object.freeze({
    version: 1,
    async observe(request) {
      params(request, ["requestId"]);
      if (disposed) throw new Error("rendered reference provider is disposed");
      if (lease) throw new Error("rendered reference request is already pending or leased");
      const owned = { requestId: request.requestId };
      lease = owned;
      const cancelled = new Promise((_resolve, reject) => {
        owned.cancel = () => reject(new Error("rendered reference owner closed or released before observation"));
      });
      try {
        await Promise.race([document.fonts.ready, cancelled]);
        if (disposed || lease !== owned) throw new Error("rendered reference owner closed before observation");
        await Promise.race([new Promise((resolve, reject) => {
          rejectFrame = reject;
          let delivered = false;
          const id = view.requestAnimationFrame(() => { delivered = true; pendingFrame = null; rejectFrame = null; resolve(); });
          if (!delivered) pendingFrame = id;
        }), cancelled]);
        if (disposed || lease !== owned) throw new Error("rendered reference owner closed or released before observation");
        const observed = read();
        const actualRevision = { kind: "dom-layout", value: revision };
        Object.assign(owned, { revision: actualRevision, observed });
        return { schemaVersion: 1, sourceKind: "native-document", provider, requestId: request.requestId,
          revision: { ...actualRevision }, documentTimeOriginMs: view.performance.timeOrigin, ...structuredClone(observed) };
      } catch (error) {
        if (lease === owned) lease = null;
        throw error;
      }
    },
    async validate(request) {
      params(request, ["requestId", "revision"]);
      if (disposed || !lease || lease.requestId !== request.requestId || !same(lease.revision, request.revision)) return false;
      const observed = read();
      return lease.revision.value === revision && same(lease.observed, observed);
    },
    async release(request) {
      params(request, ["requestId"]);
      if (!lease || lease.requestId !== request.requestId) throw new Error("rendered reference release belongs to another request owner");
      const owned = lease;
      lease = null;
      if (!owned.observed) {
        owned.cancel();
        if (pendingFrame !== null) view.cancelAnimationFrame(pendingFrame);
        pendingFrame = null; rejectFrame = null;
      }
    },
    dispose() {
      if (disposed) return;
      const owned = lease;
      disposed = true; lease = null;
      if (owned && !owned.observed) owned.cancel();
      mutations.disconnect(); resize.disconnect();
      document.fonts.removeEventListener("loading", changed);
      document.fonts.removeEventListener("loadingdone", changed);
      document.fonts.removeEventListener("loadingerror", changed);
      if (pendingFrame !== null) view.cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
      rejectFrame?.(new Error("rendered reference provider is disposed"));
      rejectFrame = null;
    },
  });
}

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
