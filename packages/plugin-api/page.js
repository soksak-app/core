// 플러그인 페이지와 모달 페이지가 사용하는 인터페이스.
//
// 표면과 모달은 각각 별도 문서라 메인 페이지의 스타일시트를 상속하지 않는다. 호스트가
// 보낸 테마 토큰을 자기 루트에 설정한다.
import { page } from "@soksak/runtime";
import {
  EXPOSURE, MANIFEST, SURFACE_CORE, createExpose, declarationMap, modulePath, pagePackage, validateExposureFile,
  validateManifest,
} from "@soksak/plugin-api";

export { page };

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

/**
 * 이 문서가 등록할 수 있는 공개 항목. 문서는 `modules/<패키지>/...` 에 있으므로 같은
 * 패키지의 plugin.json 선언을 읽고, 코어 선언 중 표면 문서 항목(core.surface.*)을 더한다.
 */
async function ownDeclarations() {
  const name = pagePackage(location.pathname);
  if (!name) throw new Error(`${location.pathname} is not a plugin page`);
  const plugin = validateManifest(await fetchJson(`/${modulePath(name, MANIFEST)}`)).exposes ?? {};
  const core = validateExposureFile(await fetchJson(`/${EXPOSURE}`)).exposes;
  const surfaceCore = Object.fromEntries(Object.entries(core)
    .map(([key, list]) => [key, list.filter((entry) => entry.name.startsWith(SURFACE_CORE))]));
  return declarationMap(surfaceCore, declarationMap(plugin));
}

/** 표면 페이지의 공개 항목 등록 함수. 네이티브 호스트가 없으면 null 이다. */
export const expose = page?.exposure ? createExpose(page.exposure, ownDeclarations) : null;

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
  }));
  const events = [];
  const input = observed(() => events.slice());
  for (const type of INPUT_TYPES) {
    addEventListener(type, (event) => {
      events.push({ type, trusted: event.isTrusted, x: event.clientX ?? null, y: event.clientY ?? null, key: event.key ?? null });
      if (events.length > INPUT_KEPT) events.shift();
      input.notify();
    }, true);
  }
  document.addEventListener("readystatechange", documentState.notify);
  addEventListener("resize", documentState.notify);
  visualViewport.addEventListener("resize", documentState.notify);
  new MutationObserver(documentState.notify).observe(root, { attributes: true, attributeFilter: ["style", "class"] });
  Promise.all([
    expose.status("core.surface.document", documentState.read, documentState.subscribe),
    expose.status("core.surface.input", input.read, input.subscribe),
    expose.command("core.surface.hit", ({ x, y }) => document.elementFromPoint(x, y) !== null),
  ]).catch((error) => console.error(`core surface entries: ${error.message}`));
}

if (expose && pagePackage(location.pathname)) exposeSurfaceDocument();
