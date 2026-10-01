// 애플리케이션의 environment.json 과 설정 폴더에 설치된 플러그인의 manifest 를 불러와 등록한다.
//
// 워크벤치는 특정 플러그인을 알지 않는다. 플러그인 목록은 host 가 제공하는 /installed-plugins.json 에서 오고
// (docs/spec/installation.md), 새 스페이스의 배치와 사이드바 기본값은 environment.json 에서 온다.
import { registry as exposure } from "./exposure.js";
import { registerState } from "./plugin-states.js";
import { registerPlugin, registerSection } from "./registry.js";
import { setPluginSettings, setSidebarDefaults } from "./settings.js";
import {
  ENVIRONMENT, INSTALLED_PLUGINS, MANIFEST, checkReferences, mergeExposes, modulePath, validateDiagnostics,
  normalizeSidebarDefaults, validateEnvironment, validateInstalledPlugins, validateManifest,
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
 * environment.json 과 설치된 플러그인 목록을 불러와 검사하고 플러그인, 섹션, 사이드바 기본값을 등록한다. 진단
 * 빌드의 host 는 플러그인마다 diagnostics.json 의 선언을 보내며, 그 선언을 플러그인의 표면 선언에 더하고 진단
 * 모듈을 불러와 플러그인에 둔다.
 */
export async function loadEnvironment() {
  if (loaded) throw new Error("environment is already loaded");
  const environment = validateEnvironment(await readJson(ENVIRONMENT));
  const installed = validateInstalledPlugins(await readJson(INSTALLED_PLUGINS));
  const manifests = await Promise.all(installed.map(async ({ id, package: name, version }) => {
    const manifest = validateManifest(await readJson(modulePath(name, MANIFEST)));
    if (manifest.id !== id) throw new Error(`${INSTALLED_PLUGINS}: plugin ${id} has a plugin.json with id ${manifest.id}`);
    return { name, manifest, version };
  }));
  checkReferences(environment, manifests.map((m) => m.manifest));
  const diagnosticPlugins = Object.fromEntries(installed.filter((plugin) => plugin.diagnostics)
    .map((plugin) => [plugin.package, validateDiagnostics(manifests.find((m) => m.name === plugin.package).manifest, plugin.diagnostics)]));
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
    for (const section of manifest.sections ?? []) {
      const module = typeof section.module === "string" ? `/${modulePath(name, section.module)}`
        : Object.fromEntries(Object.entries(section.module).map(([mode, path]) => [mode, `/${modulePath(name, path)}`]));
      registerSection({ ...section, module });
    }
    if (exposes) exposure.declare(manifest.id, exposes);
    if (manifest.state) {
      registerState({ plugin: manifest.id, module: `/${modulePath(name, manifest.state.module)}`,
        // 기본값: sidecars 와 data 는 plugin.json 의 선택 필드이며 없으면 비어 있다.
        sidecars: manifest.sidecars ?? [], data: manifest.data ?? {} });
    }
  }
  setSidebarDefaults(normalizeSidebarDefaults(environment, manifests.map(({ manifest }) => manifest)));
  units = manifests.map(({ manifest, version }) => ({
    id: manifest.id, name: manifest.name, description: manifest.description, version, surface: Boolean(manifest.surface),
    // 기본값: sections 는 plugin.json 의 선택 필드이며 없으면 섹션이 없다.
    sections: (manifest.sections ?? []).map((s) => s.id),
  }));
  loaded = environment;
}

/**
 * 설치된 플러그인을 id 순서로 반환한다. 설정 창의 플러그인 목록이 쓴다.
 * 표면이 없는 플러그인도 포함한다. 항목은 {id, name, description, version, surface, sections} 다.
 */
export const pluginUnits = () => units;

/** 불러온 environment.json 을 반환한다. 불러오기 전이면 예외를 던진다. */
export function environment() {
  if (!loaded) throw new Error("environment is not loaded");
  return loaded;
}
