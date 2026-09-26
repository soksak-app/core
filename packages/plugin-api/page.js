// 플러그인 페이지와 모달 페이지가 사용하는 인터페이스.
//
// 표면과 모달은 각각 별도 문서라 메인 페이지의 스타일시트를 상속하지 않는다. 호스트가
// 보낸 테마 토큰을 자기 루트에 설정한다.
import { page as runtimePage } from "@soksak/runtime";
import {
  EXPOSURE, MANIFEST, SURFACE_CORE, createExpose, declarationMap, modulePath, orderedSidecar, pagePackage,
  validateExposureFile, validateManifest,
} from "@soksak/plugin-api";
import { createSurfaceCompositionController } from "./surface-composition.js";

/* 사이드카 이름마다 하나의 포트. 같은 사이드카로 보내는 모든 전송이 한 순서를 따른다. */
const sidecars = new Map();

/** 런타임의 page. 사이드카 전송은 호출한 순서대로 전달된다. 네이티브 호스트가 없으면 null 이다. */
const publicRuntimePage = runtimePage ? Object.fromEntries(
  Object.entries(runtimePage).filter(([name]) => name !== "document" && name !== "image"),
) : null;

export const page = runtimePage ? Object.freeze({
  ...publicRuntimePage,
  sidecar(name) {
    if (!sidecars.has(name)) sidecars.set(name, orderedSidecar(runtimePage.sidecar(name)));
    return sidecars.get(name);
  },
}) : null;

/**
 * 받은 테마를 이 문서의 루트에 설정한다. 값이 바뀌면 다시 호출된다.
 *
 * 반환한 promise 는 첫 테마를 설정한 뒤 이행된다. 공개 항목을 그 뒤에 등록하면
 * 등록된 문서는 테마가 적용된 문서다.
 */
export function followTheme() {
  return new Promise((applied) => {
    page.theme((theme) => {
      themed = true;
      const root = document.documentElement;
      root.style.colorScheme = theme.scheme;
      for (const [token, value] of Object.entries(theme.tokens)) {
        root.style.setProperty(token, value);
      }
      applied();
    });
  });
}

let themed = false;

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`failed to load ${path}: ${response.status}`);
  return response.json();
}

/** 이 문서가 속한 플러그인 패키지의 plugin.json. 문서는 `modules/<패키지>/...` 에 있다. */
export async function ownManifest() {
  const name = pagePackage(location.pathname);
  if (!name) throw new Error(`${location.pathname} is not a plugin page`);
  return validateManifest(await fetchJson(`/${modulePath(name, MANIFEST)}`));
}

/**
 * 이 문서가 등록할 수 있는 공개 항목. 같은 패키지의 plugin.json 선언에 코어 선언 중 표면
 * 문서 항목(core.surface.*)을 더한다.
 */
async function ownDeclarations() {
  // 기본값: exposes 는 plugin.json 의 선택 필드이며, 없는 플러그인은 코어 표면 항목만 등록한다.
  const plugin = (await ownManifest()).exposes ?? {};
  const core = validateExposureFile(await fetchJson(`/${EXPOSURE}`)).exposes;
  const surfaceCore = Object.fromEntries(Object.entries(core)
    .map(([key, list]) => [key, list.filter((entry) => entry.name.startsWith(SURFACE_CORE))]));
  return declarationMap(surfaceCore, declarationMap(plugin));
}

/** 표면 페이지의 공개 항목 등록 함수. 네이티브 호스트가 없으면 null 이다. */
export const expose = page?.exposure ? createExpose(page.exposure, ownDeclarations) : null;

/** 선언한 모든 네이티브 앵커를 한 번에 붙이고 한 측정에서 함께 배치한다. */
export async function createSurfaceComposition({ regions = {}, overlays = {} } = {}) {
  if (!runtimePage) return null;
  const declaration = (await ownManifest()).surface?.composition;
  return createSurfaceCompositionController(runtimePage, declaration, { regions, overlays }, window);
}

/* 표면 문서의 입력 기록. docs/spec/exposure.md 의 core.surface.input 이다. */
const INPUT_TYPES = ["pointerdown", "pointerup", "pointermove", "click", "wheel", "keydown"];
const INPUT_KEPT = 32;

/** 값이 바뀔 때 알리는 status 하나를 만든다. */
function observed(read) {
  const listeners = new Set();
  return {
    read,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    notify: () => {
      const value = read();
      for (const fn of listeners) fn(value);
    },
  };
}

/** 모든 플러그인 표면 문서에 코어 표면 항목을 등록한다. */
function exposeSurfaceDocument() {
  const root = document.documentElement;
  const documentState = observed(() => ({
    url: location.href,
    timeOrigin: performance.timeOrigin,
    readyState: document.readyState,
    themed,
    scale: devicePixelRatio,
    body: document.body
      ? { width: document.body.getBoundingClientRect().width, height: document.body.getBoundingClientRect().height }
      : null,
    viewport: { width: visualViewport.width, height: visualViewport.height },
    filter: getComputedStyle(root).filter,
    unbound: document.body ? expose.audit(document.body) : [],
  }));
  const events = [];
  let sequence = 0;
  const input = observed(() => events.slice());
  for (const type of INPUT_TYPES) {
    addEventListener(type, (event) => {
      // 기본값: 키 이벤트에는 좌표가 없고 포인터 이벤트에는 키가 없으므로 그 필드는 null 이다.
      events.push({ sequence: ++sequence, type, trusted: event.isTrusted, x: event.clientX ?? null, y: event.clientY ?? null, key: event.key ?? null });
      if (events.length > INPUT_KEPT) events.shift();
      input.notify();
    }, true);
  }
  document.addEventListener("readystatechange", documentState.notify);
  addEventListener("resize", documentState.notify);
  visualViewport.addEventListener("resize", documentState.notify);
  new MutationObserver(documentState.notify).observe(root, { attributes: true, attributeFilter: ["style", "class"] });
  // 조작 요소가 더해지거나 이름과 명령이 바뀌면 unbound 가 달라진다.
  new MutationObserver(documentState.notify).observe(root, {
    subtree: true, childList: true, attributes: true, attributeFilter: ["data-command", "data-expose", "role", "contenteditable"],
  });
  expose.onBinding(documentState.notify);
  Promise.all([
    expose.status("core.surface.document", documentState.read, documentState.subscribe),
    expose.status("core.surface.input", input.read, input.subscribe),
    expose.command("core.surface.hit", ({ x, y }) => document.elementFromPoint(x, y) !== null),
  ]).catch((error) => console.error(`core surface entries: ${error.message}`));
}

if (expose && pagePackage(location.pathname)) exposeSurfaceDocument();
