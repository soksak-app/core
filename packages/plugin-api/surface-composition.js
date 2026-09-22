// 선언된 네이티브 영역과 DOM 오버레이를 한 합성 스냅샷으로 관리한다.

import { attachRegion, regionInsets } from "./document-region.js";
import { attachImage } from "./image-region.js";

function sameNames(actual, expected, what) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (left.length !== right.length || left.some((name, index) => name !== right[index])) {
    throw new Error(`${what} must exactly match the surface declaration (expected ${right.join(", ") || "none"})`);
  }
}

function inThisDocument(element, name, view) {
  if (!(element instanceof view.Element) || element.ownerDocument !== view.document) {
    throw new Error(`surface composition ${name} must be an element in this document`);
  }
}

function restoreDataset(root, previous) {
  if (previous === undefined) delete root.dataset.surfaceComposition;
  else root.dataset.surfaceComposition = previous;
}

let paintBoundaryId = 0;
const documentBoundaryTokens = new WeakMap();

function boundaryToken(document) {
  let token = documentBoundaryTokens.get(document);
  if (!token) {
    token = `composition-${++paintBoundaryId}`;
    documentBoundaryTokens.set(document, token);
  }
  return token;
}

function installHybridPaintBoundary(regionElements, overlayElements, view, viewport = null) {
  for (const region of regionElements) {
    for (const overlay of overlayElements) {
      if (region.contains(overlay) || overlay.contains(region)) {
        throw new Error("composition overlays and native anchors cannot contain each other");
      }
    }
  }

  const token = boundaryToken(view.document);
  const attributes = new Map();
  const properties = new Map();
  const rememberAttribute = (element, name) => {
    let saved = attributes.get(element);
    if (!saved) attributes.set(element, saved = new Map());
    if (!saved.has(name)) saved.set(name, element.getAttribute(name));
  };
  const rememberProperty = (element, name) => {
    let saved = properties.get(element);
    if (!saved) properties.set(element, saved = new Map());
    if (!saved.has(name)) {
      saved.set(name, {
        value: element.style.getPropertyValue(name),
        priority: element.style.getPropertyPriority(name),
      });
    }
  };
  const setAttribute = (element, name) => {
    rememberAttribute(element, name);
    if (element.getAttribute(name) !== token) element.setAttribute(name, token);
  };
  const setProperty = (element, name, value) => {
    rememberProperty(element, name);
    if (element.style.getPropertyValue(name) !== value || element.style.getPropertyPriority(name) !== "important") {
      element.style.setProperty(name, value, "important");
    }
  };
  const ancestors = new Set();
  for (const region of regionElements) {
    for (let node = region.parentElement; node; node = node.parentElement) ancestors.add(node);
    const root = region.getRootNode?.();
    if (root?.host) ancestors.add(root.host);
  }
  if (viewport) {
    for (let node = viewport; node; node = node.parentElement) {
      ancestors.add(node);
      // The plane is the explicit app-DOM paint boundary. Its ancestors paint
      // the window background and must not be made transparent globally.
      if (node.classList?.contains("plane")) break;
    }
  }
  const enforce = () => {
    for (const region of regionElements) {
      setAttribute(region, "data-soksak-native-anchor");
      setProperty(region, "opacity", "0");
      setProperty(region, "pointer-events", "auto");
    }
    for (const ancestor of ancestors) {
      setAttribute(ancestor, "data-soksak-native-ancestor");
      setProperty(ancestor, "background-color", "transparent");
      setProperty(ancestor, "background-image", "none");
      setProperty(ancestor, "box-shadow", "none");
    }
    for (const overlay of overlayElements) {
      setProperty(overlay, "pointer-events", "auto");
      setProperty(overlay, "contain", "paint");
    }
  };
  enforce();
  const observers = [];
  const observe = (target) => {
    if (!target) return;
    const observer = new view.MutationObserver(enforce);
    observer.observe(target, {
    attributes: true,
    attributeFilter: [
      "style", "data-soksak-native-anchor", "data-soksak-native-ancestor",
    ],
    subtree: true,
    });
    observers.push(observer);
  };
  observe(regionElements[0]?.getRootNode?.() ?? view.document.documentElement);
  if (viewport) observe(viewport);
  return {
    enforce,
    restore() {
      for (const observer of observers) observer.disconnect();
      for (const [element, saved] of properties) {
        for (const [name, previous] of saved) {
          if (previous.value === "") element.style.removeProperty(name);
          else element.style.setProperty(name, previous.value, previous.priority);
        }
      }
      for (const [element, saved] of attributes) {
        for (const [name, previous] of saved) {
          if (previous === null) element.removeAttribute(name);
          else element.setAttribute(name, previous);
        }
      }
    },
  };
}

/**
 * 검증한 선언과 런타임 포트로 표면 합성을 만든다. page.js만 이 내부 함수를 호출하며,
 * 별도 모듈로 둔 이유는 전체 스냅샷과 실패 정리를 브라우저 없이 검증하기 위해서다.
 */
export async function createSurfaceCompositionController(
  runtimePage,
  declaration,
  { regions = {}, overlays = {} } = {},
  view = window,
  viewport = null,
) {
  if (!declaration) throw new Error("this page has no surface composition declaration");
  const declaredRegions = declaration.kind === "hybrid" ? declaration.regions : [];
  const declaredOverlays = declaration.kind === "hybrid" ? declaration.overlays : [];
  sameNames(Object.keys(regions), declaredRegions.map((region) => region.name), "composition regions");
  sameNames(Object.keys(overlays), declaredOverlays, "composition overlays");
  for (const [name, element] of Object.entries({ ...regions, ...overlays })) {
    inThisDocument(element, name, view);
  }

  // A DOM surface has no native plane to declare or place. Calling the host
  // composition API here creates a lifecycle race: the DOM module can be
  // mounted before the first native surface sync and can continue publishing
  // frames after its surface is removed. Hybrid surfaces use the controller
  // below; DOM surfaces only need a lifecycle handle for their module.
  if (declaration.kind === "dom") {
    let active = true;
    return Object.freeze({
      kind: "dom",
      update(change) {
        if (typeof change !== "function") return Promise.reject(new Error("composition.update requires a function"));
        if (!active) return Promise.reject(new Error("surface composition is inactive"));
        change();
        return Promise.resolve();
      },
      dispose() { active = false; return Promise.resolve(); },
    });
  }

  const viewportOf = () => typeof viewport === "function" ? viewport() : viewport;
  const compositionRoot = viewportOf() ?? view.document.documentElement;
  const root = compositionRoot;
  const previousComposition = root.dataset.surfaceComposition;
  root.dataset.surfaceComposition = declaration.kind;
  let paintBoundary = null;
  const internal = new Map();
  let active = true;
  let observer = null;
  let changed = null;
  let frame = null;
  let resizeFrame = null;
  let pending = Promise.resolve();
  const reportFailure = (error) => {
    const message = `surface composition failed: ${error?.message ?? error}`;
    runtimePage.surfaces.report(message);
    console.error(message);
  };

  let cleanupPromise = null;
  const detachAll = () => cleanupPromise ??= (async () => {
    active = false;
    observer?.disconnect();
    if (changed) {
      view.removeEventListener("resize", changed);
      view.removeEventListener("scroll", changed, true);
    }
    if (frame !== null) view.cancelAnimationFrame(frame);
    if (resizeFrame !== null) view.cancelAnimationFrame(resizeFrame);
    await pending;
    const results = await Promise.allSettled([...internal.values()].map(({ handle }) => handle.detach()));
    paintBoundary?.restore();
    restoreDataset(root, previousComposition);
    const failures = results.filter((result) => result.status === "rejected");
    for (const failure of failures) runtimePage.surfaces.report(`surface composition cleanup failed: ${failure.reason?.message ?? failure.reason}`);
    if (failures.length) throw new AggregateError(failures.map(({ reason }) => reason), "surface composition cleanup failed");
  })();

  try {
    if (declaration.kind === "hybrid") {
      paintBoundary = installHybridPaintBoundary(Object.values(regions), Object.values(overlays), view, viewportOf());
    }
    for (const declared of declaredRegions) {
      const element = regions[declared.name];
      const handle = declared.kind === "document"
        ? attachRegion(runtimePage.document, element, declared.name, view, { observe: false })
        : attachImage(runtimePage.image, element, declared.name, declared.sidecar, view, { observe: false });
      internal.set(declared.name, { declared, element, handle });
    }

    const attached = await Promise.allSettled([...internal.values()].map(({ handle }) => handle._ready));
    const failed = attached.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;

    let revision = 0;
    let acceptedGeometry = null;
    let pendingGeometry = null;
    const measured = (name, element) => {
      const { insets: viewportInsets, visible } = regionInsets(element, view);
      const currentViewport = viewportOf();
      const insets = currentViewport
        ? (() => {
            const region = element.getBoundingClientRect();
            const rootRect = currentViewport.getBoundingClientRect();
            return {
            left: region.left - rootRect.left,
            top: region.top - rootRect.top,
            right: rootRect.right - region.right,
            bottom: rootRect.bottom - region.bottom,
          };
        })()
        : viewportInsets;
      return { name, ...insets, visible };
    };
    const snapshot = () => {
      paintBoundary?.enforce();
      const regionSnapshot = [...internal.values()]
        .map(({ declared, element }) => measured(declared.name, element));
      const overlaySnapshot = declaredOverlays
        .map((name) => measured(name, overlays[name]));
      return { regionSnapshot, overlaySnapshot };
    };
    const place = (force = false) => {
      const { regionSnapshot, overlaySnapshot } = snapshot();
      const geometry = JSON.stringify([regionSnapshot, overlaySnapshot]);
      if (!force && (geometry === acceptedGeometry || geometry === pendingGeometry)) return pending;
      const current = ++revision;
      pendingGeometry = geometry;
      const work = pending.catch((error) => {
        reportFailure(error);
      }).then(() => {
        if (!active) throw new Error("surface composition is inactive");
        return runtimePage.composition.place(current, regionSnapshot, overlaySnapshot);
      }).then((result) => {
        acceptedGeometry = geometry;
        if (pendingGeometry === geometry) pendingGeometry = null;
        return result;
      }, (error) => {
        if (pendingGeometry === geometry) pendingGeometry = null;
        throw error;
      });
      pending = work.catch(reportFailure);
      return work;
    };

    // A full-surface region can keep identical insets while its raster size changes.
    // The host must receive a new composition snapshot for that size change.
    observer = new view.ResizeObserver(() => { place(true).catch(reportFailure); });
    const observed = new Set();
    for (const element of [...Object.values(regions), ...Object.values(overlays)]) {
      for (let node = element; node; node = node.parentElement) {
        if (!observed.has(node)) {
          observed.add(node);
          observer.observe(node);
        }
      }
    }
    const initialViewport = viewportOf();
    if (initialViewport && !observed.has(initialViewport)) {
      observed.add(initialViewport);
      observer.observe(initialViewport);
    }
    changed = () => {
      if (resizeFrame !== null) return;
      resizeFrame = view.requestAnimationFrame(() => {
        resizeFrame = null;
        place(true).catch(reportFailure);
      });
    };
    view.addEventListener("resize", changed);
    view.addEventListener("scroll", changed, true);
    await place(true);
    const compareGeometry = () => {
      if (!active) return;
      place().catch(reportFailure);
      frame = view.requestAnimationFrame(compareGeometry);
    };
    frame = view.requestAnimationFrame(compareGeometry);

    const region = (name) => {
      const entry = internal.get(name);
      if (!entry) throw new Error(`surface composition has no region ${JSON.stringify(name)}`);
      const handle = entry.handle;
      if (entry.declared.kind === "document") {
        const exposed = {
          name, onState: handle.onState, load: handle.load, go: handle.go,
          back: handle.back.bind(handle), forward: handle.forward.bind(handle),
          reload: handle.reload.bind(handle), stop: handle.stop.bind(handle),
        };
        Object.defineProperty(exposed, "state", { get: () => handle.state });
        return Object.freeze(exposed);
      }
      return Object.freeze({
        name, on: handle.on, focus: handle.focus, setCaret: handle.setCaret,
        setAccessibleText: handle.setAccessibleText,
      });
    };

    return Object.freeze({
      kind: declaration.kind,
      region,
      update(change) {
        if (typeof change !== "function") return Promise.reject(new Error("composition.update requires a function"));
        try {
          change();
        } catch (error) {
          return Promise.reject(error);
        }
        return place(true);
      },
      dispose: detachAll,
    });
  } catch (error) {
    try {
      await detachAll();
    } catch (cleanupError) {
      runtimePage.surfaces.report(`surface composition cleanup failed: ${cleanupError.message}`);
    }
    throw error;
  }
}
