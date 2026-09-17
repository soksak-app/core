// 애플리케이션의 environment.json 과 그 안에 적힌 플러그인 manifest 를 불러와 등록한다.
//
// 워크벤치는 특정 플러그인을 알지 않는다. 플러그인 목록, 새 스페이스의 배치,
// 사이드바 기본값은 모두 이 파일이 불러온 값에서 온다.
import { registry as exposure } from "./exposure.js";
import { registerPlugin, registerSection } from "./registry.js";
import { setSidebarDefaults } from "./settings.js";
import {
  ENVIRONMENT, MANIFEST, checkReferences, modulePath, validateEnvironment, validateManifest,
} from "@soksak/plugin-api";

let loaded = null;

async function readJson(path) {
  const response = await fetch(`/${path}`);
  if (!response.ok) throw new Error(`failed to load /${path}: ${response.status}`);
  return response.json();
}

/** 표면 선언을 탭 id 로 표면 대상을 반환하는 함수로 바꾼다. */
function surfaceOf(name, surface) {
  const page = modulePath(name, surface.page);
  return (tabId) => ({ page: `${page}?id=${encodeURIComponent(tabId)}` });
}

/** environment.json 을 불러와 검사하고 플러그인, 섹션, 사이드바 기본값을 등록한다. */
export async function loadEnvironment() {
  if (loaded) throw new Error("environment is already loaded");
  const environment = validateEnvironment(await readJson(ENVIRONMENT));
  const manifests = await Promise.all(environment.plugins.map(async (name) =>
    ({ name, manifest: validateManifest(await readJson(modulePath(name, MANIFEST))) })));
  checkReferences(environment, manifests.map((m) => m.manifest));
  for (const { name, manifest } of manifests) {
    if (manifest.surface) {
      registerPlugin({
        id: manifest.id, name: manifest.name, mark: manifest.mark, svg: manifest.icon,
        ink: manifest.preview?.ink ?? null,
        surface: surfaceOf(name, manifest.surface),
      });
    }
    for (const section of manifest.sections ?? []) registerSection(section);
    if (manifest.exposes) exposure.declare(manifest.id, manifest.exposes);
  }
  setSidebarDefaults(environment.sidebars);
  loaded = environment;
}

/** 불러온 environment.json 을 반환한다. 불러오기 전이면 예외를 던진다. */
export function environment() {
  if (!loaded) throw new Error("environment is not loaded");
  return loaded;
}
