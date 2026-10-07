import { createSurfaceCompositionController, createSurfaceContext, mountSurfaceModule, releaseSurfaceReady } from "@soksak/plugin-api";
import { native, onSurfacePrepared, surfaces as hostSurfaces, surfaceContextRuntime } from "./host.js";
import { registry } from "./exposure.js";
import { plugin } from "./registry.js";
import { pluginDiagnostics } from "./environment.js";
import { registerSurfaceExposure } from "./surface-exposure.js";
import { onSettingsChange, pluginSettings } from "./settings.js";
import { onTextSize, surfaceTextSize } from "./text-size.js";
import { forgetTab, reportDirectory, reportFooter, reportNotice, reportTitle, tabOrigin } from "./tab-reports.js";
import { icon } from "./icons.js";
import { active } from "./projects.js";
const mounted = new Map();
/* 호스트가 없는 문서에서 마운트하지 않은 표면의 자리 표시. 표면 id 마다 요소다. */
const placeholders = new Map();
const parking = document.createDocumentFragment();
const authorization = new Map();

function authorizationFor(id) {
  let gate = authorization.get(id);
  if (!gate) {
    let resolve;
    gate = { promise: new Promise((done) => { resolve = done; }), resolve };
    authorization.set(id, gate);
  }
  return gate.promise;
}

export function authorizeSurface(id) {
  const gate = authorization.get(id);
  if (gate) gate.resolve();
  else authorization.set(id, { promise: Promise.resolve(), resolve() {} });
}

// 호스트가 native handle을 만든 뒤에만 native surface 모듈을 시작한다.
// 이 준비 callback이 production 승인 경로다. 이것이 없으면 native mount는
// 원인을 밝힐 수 있는 오류를 보고하기 전에 무기한 기다린다.
if (native) {
  onSurfacePrepared((placements) => {
    for (const placement of placements) authorizeSurface(placement.id);
  });
}

// 이 문서가 호스트에 보낸 마지막 composition revision. 호스트는 표면마다 revision 이 커지기를 요구하고, 표면이 파괴되거나
// 문서가 바뀔 때만 그 값을 지운다. 같은 문서에서 다시 마운트한 표면의 새 composition 은 1부터 세므로, 문서의 모든 배치를
// 하나의 증가하는 번호로 보낸다(docs/spec/surface-composition.md).
let compositionRevision = 0;

function pageRuntime(surface, scoped, compositionReady) {
  const invoke = (name, payload) => scoped.native.call(name, payload);
  return {
    surfaces: { report: (message) => invoke("report", message) },
    document: {
      attach: (name) => invoke("documentAttach", { document: name }),
      load: (name, url) => invoke("documentLoad", { document: name, url }),
      zoom: (name, zoom) => invoke("documentZoom", { document: name, zoom }),
      go: (name, action, offset) => invoke("documentGo", offset === undefined ? { document: name, action } : { document: name, action, offset }),
      detach: (name) => invoke("documentDetach", { document: name }),
      onState: (listener) => scoped.native.on("document-state", (event) => listener(event.document, event.state)),
    },
    image: {
      attach: (name, sidecar) => invoke("imageAttach", { name, sidecar }),
      place: (name, insets, visible) => invoke("imagePlace", { name, insets, visible }),
      focus: (name) => invoke("imageFocus", { name }),
      caret: (name, x, y, width, height) => invoke("imageCaret", { name, x, y, width, height }),
      text: (name, text) => invoke("imageText", { name, text }),
      detach: (name) => invoke("imageDetach", { name }),
      on: (listener) => scoped.native.on("image-event", (event) => listener(event.name, event.event)),
    },
    composition: {
      declare: async (declaration) => {
        try {
          const result = await invoke("compositionDeclare", { composition: declaration });
          compositionReady.resolve();
          return result;
        } catch (error) {
          compositionReady.reject(error);
          throw error;
        }
      },
      // composition 안의 순서는 호출 순서와 같으므로 composition 의 revision 대신 문서의 다음 번호를 보낸다.
      place: (_revision, regions, overlays) => {
        const revision = ++compositionRevision;
        return invoke("compositionPlace", { revision, regions, overlays });
      },
    },
    sidecar: scoped.sidecar,
  };
}

/**
 * 불러오지 않은 플러그인 탭의 자리 표시를 slot 에 둔다(docs/spec/plugins.md). 같은 slot 의 마운트된 표면은
 * 다른 표면을 마운트할 때처럼 보관 자리로 옮긴다. 자리 표시는 탭이 닫히면 disposeSurface 가 지운다.
 */
export function placePluginPlaceholder(slot, surfaceId, element) {
  for (const other of mounted.values()) {
    if (other.slot === slot) {
      other.host.dataset.surfaceSuspended = "true";
      parking.append(other.host);
    }
  }
  clearSlotPlaceholders(slot, surfaceId);
  placeholders.get(surfaceId)?.remove();
  element.classList.add("surface-placeholder");
  element.dataset.surfaceId = surfaceId;
  slot.append(element);
  placeholders.set(surfaceId, element);
}

/** slot 에 남은 다른 탭의 자리 표시를 지운다. 같은 카드의 다른 탭이 보이면 그 탭의 자리 표시는 남지 않는다. */
function clearSlotPlaceholders(slot, surfaceId) {
  for (const [id, element] of placeholders) {
    if (id !== surfaceId && element.parentNode === slot) {
      element.remove();
      placeholders.delete(id);
    }
  }
}

export async function mountSurface(slot, surface, { onState = () => {} } = {}) {
  if (!slot || !surface?.module) throw new TypeError("surface module mount requires a slot and module");
  clearSlotPlaceholders(slot, surface.surfaceId);
  // 호스트가 없으면 사이드카와 네이티브 영역이 없다. 그것이 필요한 표면은 마운트하지 않고 자리 표시를 그린다
  // (docs/spec/plugins.md#runtime-module).
  if (!native && (surface.sidecars.length > 0 || surface.composition?.kind === "hybrid")) {
    const placeholder = document.createElement("div");
    placeholder.className = "surface-placeholder";
    placeholder.dataset.surfaceId = surface.surfaceId;
    placeholder.style.cssText = "position:absolute;inset:0;display:grid;place-items:center;color:var(--muted)";
    placeholder.textContent = `${plugin(surface.pluginId).name} 표면은 네이티브 호스트가 있어야 열립니다`;
    placeholders.get(surface.surfaceId)?.remove();
    slot.querySelector(":scope > .surface-placeholder")?.remove();
    slot.append(placeholder);
    placeholders.set(surface.surfaceId, placeholder);
    onState({ phase: "ready" });
    return null;
  }
  const view = slot.ownerDocument.defaultView;
  let entry = mounted.get(surface.surfaceId);
  if (entry && entry.slot === slot) {
    if (entry.host.parentNode !== slot) slot.appendChild(entry.host);
    entry.host.removeAttribute("data-surface-suspended");
    return entry.ready;
  }
  if (!entry) {
    for (const other of mounted.values()) {
      if (other.slot === slot && other.surfaceId !== surface.surfaceId) {
        other.host.dataset.surfaceSuspended = "true";
        parking.append(other.host);
      }
    }
    const host = document.createElement("div");
    host.className = "surface-module-host";
    // 글자 배율은 app.css 의 .surface-module-host 가 정한다(docs/spec/text-size.md).
    host.style.cssText = "position:absolute;inset:0;overflow:hidden";
    slot.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const scoped = surfaceContextRuntime(surface, surface.declarations);
    let resolveComposition;
    let rejectComposition;
    const compositionReady = {
      promise: new Promise((resolve, reject) => { resolveComposition = resolve; rejectComposition = reject; }),
      resolve: resolveComposition,
      reject: rejectComposition,
    };
    if (!native) compositionReady.resolve();
    const page = pageRuntime(surface, scoped, compositionReady);
    let viewport = slot;
    const eventListeners = new Map();
    const emit = (type, detail) => {
      // 기본값: 듣는 곳이 없는 사건 종류는 알릴 수신자가 없다.
      for (const listener of eventListeners.get(type) ?? []) listener(detail);
    };
    const on = (type, listener) => {
      if (!eventListeners.has(type)) eventListeners.set(type, new Set());
      eventListeners.get(type).add(listener);
      return () => eventListeners.get(type)?.delete(listener);
    };
    // 모듈이 만든 composition. 표면을 제거할 때 모듈의 dispose 보다 먼저 해제한다(disposeModule).
    const compositions = [];
    const composition = {
      create: async (elements) => {
        await page.composition.declare(surface.composition);
        const controller = await createSurfaceCompositionController(page, surface.composition, elements, view,
          () => viewport);
        compositions.push(controller);
        return controller;
      },
    };
    // 마운트는 탭이 판에 있을 때 시작한다. 탭이 판에서 빠지면 해제될 때까지 마지막 배율을 유지한다
    // (docs/spec/text-size.md). 마운트 도중 빠져도 모듈은 마운트를 시작한 때의 배율을 읽는다.
    let factor = surfaceTextSize(surface.surfaceId);
    // 진단 모듈. 모듈을 불러오기 전에 채운다.
    let diagnostics = null;
    const context = createSurfaceContext({
      root: shadow, surfaceId: surface.surfaceId, pluginId: surface.pluginId,
      declarations: surface.declarations, composition, diagnostics: () => diagnostics,
      tab: { title: (text) => reportTitle(surface.surfaceId, text),
        footer: (text) => reportFooter(surface.surfaceId, text),
        directory: (path) => reportDirectory(surface.surfaceId, path),
        notify: (text, policy) => reportNotice(surface.surfaceId, text, policy) },
      origin: tabOrigin(surface.surfaceId),
      // 표면 창이 보이는 프로젝트의 정규 루트(docs/spec/plugins.md#tab-reports). 라이브러리 창에는 없다.
      project: active() ? { root: active().root } : null,
      icon,
      runtime: { sidecar: scoped.sidecar, native: scoped.native, exposure: scoped.exposure, emit, on,
        clipboard: scoped.clipboard,
        links: scoped.links,
        theme: scoped.theme,
        // 이 표면의 실제 글자 배율(docs/spec/text-size.md). 알림마다 다시 읽고 바뀐 값만 전달한다.
        textSize: { read: () => {
          // 기본값: 판에 없는 탭의 배율은 null 이므로 마지막으로 알린 배율을 유지한다.
          factor = surfaceTextSize(surface.surfaceId) ?? factor;
          if (factor === null) throw new Error(`surface ${surface.surfaceId} is not in the layout`);
          return factor;
        }, on: (listener) => {
          // 기본값: 판에 없는 탭의 배율은 null 이므로 마지막으로 알린 배율을 유지한다.
          let last = surfaceTextSize(surface.surfaceId) ?? factor;
          return onTextSize(() => {
            const next = surfaceTextSize(surface.surfaceId);
            if (next === null || next === last) return;
            last = next;
            factor = next;
            listener(next);
          });
        } },
        settings: { read: () => pluginSettings(surface.pluginId), on: (listener) =>
          onSettingsChange(() => listener(pluginSettings(surface.pluginId))) },
      },
    });
    const state = context.status.subscribe(onState);
    onState(context.status.read());
    entry = { slot, host, shadow, context, state, exposure: null, composition: compositionReady.promise, compositions,
      mounted: null, ready: null, authorized: false, disposed: false, surfaceId: surface.surfaceId,
      setViewport: (next) => { viewport = next; } };
    mounted.set(surface.surfaceId, entry);
    entry.mounted = (native ? authorizationFor(surface.surfaceId) : Promise.resolve())
      .then(async () => {
        // 승인 대기 중 제거된 표면의 등록과 모듈을 시작하지 않는다.
        if (entry.disposed) return null;
        entry.authorized = true;
        // 코어와 플러그인의 등록을 같은 네이티브 승인 뒤에 시작한다.
        entry.exposure = registerSurfaceExposure({ root: shadow, expose: context.exposure, view,
          declarations: registry.surfaceDeclarations() });
        await entry.exposure.ready;
        diagnostics = await pluginDiagnostics(surface.pluginId);
        if (entry.disposed) return null;
        return import(surface.module);
      }).then((module) => {
        return module && mountSurfaceModule(module, shadow, context);
      })
      ;
    entry.ready = entry.mounted.then(async (mountedModule) => {
        if (!mountedModule) return null;
        if (entry.disposed) {
          await disposeModule(entry, mountedModule);
          return null;
        }
        entry.module = mountedModule;
        // 새로 만든 native surface는 첫 표시가 그 image raster를 기다릴 수 있기 전에
        // image를 선언하고 배치해야 한다. 여기서 기다리면
        // 순환이 생긴다: 표시는 모듈을 기다리고, 모듈의
        // composition은 raster를 구성하는 작업이다.
        releaseSurfaceReady(context);
        return mountedModule;
      }).catch((error) => {
        if (entry.disposed) return null;
        context.status.report("error", error);
        throw error;
      });
  } else {
    for (const other of mounted.values()) {
      if (other.slot === slot && other.surfaceId !== surface.surfaceId) {
        other.host.dataset.surfaceSuspended = "true";
        parking.append(other.host);
      }
    }
    entry.slot = slot;
    entry.setViewport(slot);
    if (entry.host.parentNode !== slot) slot.appendChild(entry.host);
    entry.host.removeAttribute("data-surface-suspended");
  }
  return entry.ready;
}

/** 네이티브 표면이 composition 을 선언할 때까지 기다린다. 마운트에 실패한 모듈은 선언하지 않으므로 그 마운트 오류로도 끝난다. */
export async function waitSurfaceCompositionDeclared(surfaceId) {
  if (placeholders.has(surfaceId)) return;
  const entry = mounted.get(surfaceId);
  if (!entry) throw new Error(`surface ${surfaceId} is not mounted`);
  await Promise.race([entry.composition, entry.ready.then(() => entry.composition)]);
}

/**
 * mount된 surface의 카드가 settled된 뒤 그 native 입력 소유자에게 focus를 준다. 기다리는 동안 탭이 닫혀 표면의 해제가
 * 시작되면 해제된 모듈의 영역은 focus 를 받지 않으므로 focus 를 주지 않고 false 를 돌려준다.
 */
export async function focusSurface(surfaceId) {
  if (placeholders.has(surfaceId)) return false;
  const entry = mounted.get(surfaceId);
  if (!entry) throw new Error(`surface ${surfaceId} is not mounted`);
  await entry.ready;
  if (typeof entry.module?.focus !== "function") return false;
  if (native) await hostSurfaces.waitPresented();
  if (entry.disposed) return false;
  await entry.module.focus();
  return true;
}

export function suspendSurface(surfaceId) {
  const entry = mounted.get(surfaceId);
  if (entry) entry.host.dataset.surfaceSuspended = "true";
}

/**
 * 표면의 영역을 떼고 모듈을 해제한다. 모듈의 dispose 는 사이드카 세션을 끝내고, 공급자는 세션을 끝낼 때 전송 그림을
 * 놓는다. 영역을 먼저 떼므로 공급자가 그 전에 보낸 프레임은 stale 로 답하고, 붙은 영역이 놓인 그림을 표시하지 않는다
 * (docs/spec/plugins.md#surface-module-ownership). composition 의 해제는 반복해도 같은 정리를 기다리므로 모듈이 다시 해제해도 된다.
 */
async function disposeModule(entry, module) {
  for (const composition of entry.compositions) await composition.dispose();
  await module.dispose();
}

export async function disposeSurface(surfaceId) {
  placeholders.get(surfaceId)?.remove();
  placeholders.delete(surfaceId);
  const entry = mounted.get(surfaceId);
  if (!entry) return;
  if (entry.disposing) return entry.disposing;
  entry.disposed = true;
  entry.disposing = (async () => {
    // 여기서 승인을 기다리지 않는다. 제거된 탭은 모듈이 mount를 허가받은 적이 없다는
    // 이유만으로 layout commit을 살려 두면 안 된다.
    if (entry.module) await disposeModule(entry, entry.module);
    // 실패한 마운트는 오류를 표면 상태와 mountSurface 호출자에게 이미 보고했다. 해제는 마운트가 끝나기만 기다린다.
    else if (entry.authorized) await Promise.allSettled([entry.ready]);
    if (entry.exposure) entry.exposure.dispose();
    await entry.context.exposure.dispose();
    entry.state();
    entry.host.removeAttribute("data-surface-suspended");
    entry.host.remove();
    forgetTab(surfaceId);
    authorization.delete(surfaceId);
    if (mounted.get(surfaceId) === entry) mounted.delete(surfaceId);
  })();
  return entry.disposing;
}

// 기본값: 마운트되지 않은 표면은 null 이다.
export const mountedSurface = (surfaceId) => mounted.get(surfaceId) ?? null;

/** 현재 workspace가 더 이상 선언하지 않는 탭의 모듈을 dispose한다. */
export async function disposeSurfacesExcept(surfaceIds) {
  for (const [id, placeholder] of placeholders) {
    if (surfaceIds.has(id)) continue;
    placeholder.remove();
    placeholders.delete(id);
  }
  const stale = [...mounted.keys()].filter((id) => !surfaceIds.has(id));
  await Promise.all(stale.map((id) => disposeSurface(id)));
}
