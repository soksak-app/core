// 애플리케이션의 environment.json 과 그 안에 적힌 플러그인 manifest 를 불러와 등록한다.
//
// 워크벤치는 특정 플러그인을 알지 않는다. 플러그인 목록, 새 스페이스의 배치,
// 사이드바 기본값은 모두 이 파일이 불러온 값에서 온다.
import { registry as exposure } from "./exposure.js";
import { registerState } from "./plugin-states.js";
import { registerPlugin, registerSection } from "./registry.js";
import { setPluginSettings, setSidebarDefaults } from "./settings.js";
import {
  DIAGNOSTIC_PLUGINS, ENVIRONMENT, MANIFEST, checkReferences, mergeExposes, modulePath, validateDiagnosticPlugins,
  normalizeSidebarDefaults, validateEnvironment, validateManifest,
} from "@soksak/plugin-api";

let loaded = null;
let units = [];

async function readJson(path) {
  const response = await fetch(`/${path}`);
  if (!response.ok) throw new Error(`failed to load /${path}: ${response.status}`);
  return response.json();
}

/** 표면 선언을 탭 id 로 표면 모듈 대상을 반환하는 함수로 바꾼다. */
function surfaceOf(name, pluginId, surface) {
  const module = `/${modulePath(name, surface.module)}`;
  return (tabId) => ({ module, composition: surface.composition, surfaceId: tabId,
    pluginId, declarations: surface.declarations, sidecars: surface.sidecars });
}

/**
 * environment.json 을 불러와 검사하고 플러그인, 섹션, 사이드바 기본값을 등록한다. 진단 빌드에서는
 * diagnostic-plugins.json 의 선언을 그 플러그인의 표면 선언에 더하고, 진단 모듈을 불러와 플러그인에 둔다.
 */
export async function loadEnvironment() {
  if (loaded) throw new Error("environment is already loaded");
  const environment = validateEnvironment(await readJson(ENVIRONMENT));
  const manifests = await Promise.all(environment.plugins.map(async (name) =>
    ({ name, manifest: validateManifest(await readJson(modulePath(name, MANIFEST))) })));
  checkReferences(environment, manifests.map((m) => m.manifest));
  const diagnosticPlugins = validateDiagnosticPlugins(await readJson(DIAGNOSTIC_PLUGINS),
    new Map(manifests.map((m) => [m.name, m.manifest])));
  // 기본값: environment.json 의 settings 는 선택 필드이며 없으면 플러그인 설정을 덮어쓰지 않는다.
  setPluginSettings(manifests.map((m) => m.manifest), environment.settings ?? {});
  const diagnosticModules = new Map(await Promise.all(Object.entries(diagnosticPlugins).map(async ([name, declared]) =>
    [name, await import(`/${modulePath(name, declared.module)}`)])));
  for (const { name, manifest } of manifests) {
    // 기본값: 진단 모듈은 진단 빌드의 일부 플러그인에만 있으며 없으면 null 이다.
    const diagnostics = diagnosticPlugins[name] ?? null;
    // 기본값: exposes 는 plugin.json 의 선택 필드이며 없으면 선언이 없다(docs/spec/plugins.md).
    const exposes = diagnostics ? mergeExposes(manifest.exposes ?? {}, diagnostics.exposes) : manifest.exposes;
    if (manifest.surface) {
      registerPlugin({
        id: manifest.id, name: manifest.name, mark: manifest.mark, svg: manifest.icon,
        // 기본값: preview 는 plugin.json 의 선택 필드이며 없으면 미리 보기 잉크가 없다(null).
        ink: manifest.preview?.ink ?? null,
        // 기본값: background 는 plugin.json 의 선택 필드이며 없으면 배경 세션이 없다(null).
        background: manifest.background ?? null,
        // 기본값: 진단 모듈은 진단 빌드의 일부 플러그인에만 있으며 없으면 null 이다.
        diagnostics: diagnosticModules.get(name) ?? null,
        // 기본값: surface.drop 은 선택 필드이며 없으면 그 표면은 놓기를 받지 않는다(null).
        drop: manifest.surface?.drop ?? null,
        surface: surfaceOf(name, manifest.id, {
          ...manifest.surface,
          // 기본값: exposes 는 plugin.json 의 선택 필드이며 없으면 선언이 없다.
          declarations: exposes ?? {},
          // 기본값: sidecars 는 plugin.json 의 선택 필드이며 없으면 사이드카가 없다.
          sidecars: manifest.sidecars ?? [],
        }),
      });
    }
    // 섹션 모듈은 표면 모듈처럼 그 패키지 경로에서 불러온다.
    // 기본값: sections 는 plugin.json 의 선택 필드이며 없으면 섹션이 없다.
    for (const section of manifest.sections ?? []) registerSection({ ...section, module: `/${modulePath(name, section.module)}` });
    if (exposes) exposure.declare(manifest.id, exposes);
    if (manifest.state) {
      registerState({ plugin: manifest.id, module: `/${modulePath(name, manifest.state.module)}`,
        // 기본값: sidecars 와 data 는 plugin.json 의 선택 필드이며 없으면 비어 있다.
        sidecars: manifest.sidecars ?? [], data: manifest.data ?? {} });
    }
  }
  setSidebarDefaults(normalizeSidebarDefaults(environment, manifests.map(({ manifest }) => manifest)));
  units = manifests.map(({ manifest }) => ({
    id: manifest.id, name: manifest.name, description: manifest.description, surface: Boolean(manifest.surface),
    // 기본값: sections 는 plugin.json 의 선택 필드이며 없으면 섹션이 없다.
    sections: (manifest.sections ?? []).map((s) => s.id),
  }));
  loaded = environment;
}

/**
 * 환경의 플러그인을 environment.json 순서로 반환한다. 설정 창의 플러그인 목록이 쓴다.
 * 표면이 없는 플러그인도 포함한다. 항목은 {id, name, description, surface, sections} 다.
 */
export const pluginUnits = () => units;

/** 불러온 environment.json 을 반환한다. 불러오기 전이면 예외를 던진다. */
export function environment() {
  if (!loaded) throw new Error("environment is not loaded");
  return loaded;
}
