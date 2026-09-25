// 플러그인 manifest(plugin.json)와 애플리케이션 environment.json 의 형식을 검사한다.
//
// 워크벤치는 불러온 파일을 이 함수로 검사하고, 플러그인과 애플리케이션은 자기
// 테스트에서 같은 함수로 자기 파일을 검사한다.

/*
 * 스테이징된 프런트엔드의 경로 규칙.
 *
 * 워크벤치 파일은 문서 루트에 놓인다. 다른 패키지는 `modules/<패키지 이름>/` 아래에
 * 패키지 안의 경로 그대로 놓인다. 런타임 모듈은 `runtime/` 에 놓인다.
 */
import { createBinder } from "./binder.js";

export { INTERACTIVE, commandOf, createBinder, valueOf } from "./binder.js";
export { DOCUMENT_ACTIONS, DOCUMENT_NAME, observeRegionInsets, regionInsets } from "./document-region.js";
export { IMAGE_NAME } from "./image-region.js";
export { createSurfaceContext, mountSurfaceModule, releaseSurfaceReady } from "./surface.js";
export { createSurfaceCompositionController } from "./surface-composition.js";
export { orderedSidecar } from "./sidecar-port.js";
export { CLIPBOARD_TYPES, ClipboardError, createClipboardBridge, shellQuotePath } from "./clipboard.js";
export { createLinkBridge } from "./links.js";

export const ENVIRONMENT = "environment.json";
export const MANIFEST = "plugin.json";
export const SIDECAR = "sidecar.json";
export const RUNTIME = "runtime";
/** 코어가 공개하는 항목의 선언 파일. 워크벤치 패키지 루트에 있다. */
export const EXPOSURE = "exposure.json";
/** 플러그인 패키지 루트의 진단 선언 파일. 진단 빌드에만 스테이징된다. */
export const DIAGNOSTICS = "diagnostics.json";
/** 스테이징 루트의 플러그인 진단 선언 목록. 진단 빌드가 아니면 {} 다. */
export const DIAGNOSTIC_PLUGINS = "diagnostic-plugins.json";

/** 표면 문서가 등록하는 코어 항목의 이름 접두사. 다른 코어 항목은 메인 문서가 등록한다. */
export const SURFACE_CORE = "core.surface.";

/** 패키지 안의 경로를 문서 루트 기준 경로로 반환한다. */
export const modulePath = (name, path) => `modules/${name}/${path}`;

/** 모든 페이지가 선언하는 import map 의 imports. 페이지는 이 값과 같은 import map 을 갖는다. */
export const PAGE_IMPORTS = Object.freeze({
  "soksak": `/${modulePath("soksak", "dist/index.js")}`,
  "@soksak/plugin-api": `/${modulePath("@soksak/plugin-api", "index.js")}`,
  "@soksak/plugin-api/page": `/${modulePath("@soksak/plugin-api", "page.js")}`,
  "@soksak/runtime": `/${RUNTIME}/index.js`,
  "@soksak/workbench/": "/",
});

/** HTML 문서에서 import map 의 imports 를 읽는다. import map 이 하나가 아니면 예외를 던진다. */
export function pageImports(html) {
  const maps = [...html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)];
  if (maps.length !== 1) throw new Error(`expected one import map, found ${maps.length}`);
  return JSON.parse(maps[0][1]).imports;
}

const ID = /^[a-z][a-z0-9-]*$/;
const PACKAGE = /^(@[a-z0-9-]+\/)?[a-z0-9-]+$/;
const REGION = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN = /^--[a-z][a-z0-9-]*$/;
const SETTING = /^[a-z][A-Za-z0-9-]*(?:\.[a-z][A-Za-z0-9-]*)*$/;

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.length > 0;

/** 사이드카 패키지 이름 목록을 검사한다. */
function checkSidecars(where, names) {
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !PACKAGE.test(name))) {
    throw new Error(`${where}: expected sidecar package names`);
  }
  if (new Set(names).size !== names.length) throw new Error(`${where}: duplicate sidecar`);
}

function only(where, value, keys) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${where}: unknown field ${key}`);
  }
}

function checkSettingDeclaration(where, declaration) {
  if (!isObject(declaration)) throw new Error(`${where}: setting must be an object`);
  if (declaration.type === "enum") {
    only(where, declaration, ["type", "default", "values"]);
    if (!Array.isArray(declaration.values) || declaration.values.length === 0 ||
        declaration.values.some((value) => typeof value !== "string" || value.length === 0) ||
        new Set(declaration.values).size !== declaration.values.length) {
      throw new Error(`${where}: enum values must be distinct non-empty strings`);
    }
    if (!declaration.values.includes(declaration.default)) {
      throw new Error(`${where}: default must be one of values`);
    }
    return;
  }
  if (declaration.type === "integer") {
    only(where, declaration, ["type", "default", "minimum", "maximum"]);
    if (!Number.isInteger(declaration.default) || !Number.isInteger(declaration.minimum) ||
        !Number.isInteger(declaration.maximum) || declaration.minimum > declaration.maximum ||
        declaration.default < declaration.minimum || declaration.default > declaration.maximum) {
      throw new Error(`${where}: integer default and bounds are invalid`);
    }
    return;
  }
  if (declaration.type === "string") {
    only(where, declaration, ["type", "default", "maxLength"]);
    if (!Number.isInteger(declaration.maxLength) || declaration.maxLength < 1 ||
        typeof declaration.default !== "string" || declaration.default.length === 0 ||
        declaration.default.length > declaration.maxLength) {
      throw new Error(`${where}: string default and maxLength are invalid`);
    }
    return;
  }
  throw new Error(`${where}: setting type must be enum, integer, or string`);
}

function checkSettings(where, settings) {
  if (settings === undefined) return;
  if (!isObject(settings)) throw new Error(`${where}: settings must be an object`);
  for (const [key, declaration] of Object.entries(settings)) {
    if (!SETTING.test(key)) throw new Error(`${where}: invalid setting name ${key}`);
    checkSettingDeclaration(`${where}.${key}`, declaration);
  }
}

function checkSettingValue(where, declaration, value) {
  if (declaration.type === "enum" && !declaration.values.includes(value)) {
    throw new Error(`${where}: value is not declared`);
  }
  if (declaration.type === "integer" &&
      (!Number.isInteger(value) || value < declaration.minimum || value > declaration.maximum)) {
    throw new Error(`${where}: integer value is outside its declared range`);
  }
  if (declaration.type === "string" &&
      (typeof value !== "string" || value.length === 0 || value.length > declaration.maxLength)) {
    throw new Error(`${where}: string value must be non-empty and at most ${declaration.maxLength} characters`);
  }
}

export function settingDeclarations(manifest) {
  return Object.fromEntries(Object.entries(manifest.settings ?? {}).map(([key, declaration]) => [
    `${manifest.id}.${key}`, { ...declaration, plugin: manifest.id, key },
  ]));
}

/** 표면 합성 선언을 검사한다. 이 선언이 호스트의 영역 권한 목록이다. */
function checkComposition(where, composition, sidecars) {
  if (!isObject(composition)) throw new Error(`${where}: composition must be an object`);
  if (composition.kind === "dom") {
    only(`${where} composition`, composition, ["kind"]);
    return;
  }
  if (composition.kind !== "hybrid") throw new Error(`${where}: composition kind must be dom or hybrid`);
  only(`${where} composition`, composition, ["kind", "regions", "overlays"]);
  if (!Array.isArray(composition.regions) || composition.regions.length === 0) {
    throw new Error(`${where}: hybrid composition requires regions`);
  }
  if (!Array.isArray(composition.overlays)) throw new Error(`${where}: hybrid composition requires overlays`);

  const names = new Set();
  for (const region of composition.regions) {
    if (!isObject(region)) throw new Error(`${where} composition region: expected an object`);
    if (typeof region.name !== "string" || !REGION.test(region.name)) {
      throw new Error(`${where} composition: invalid region name ${region.name}`);
    }
    if (names.has(region.name)) throw new Error(`${where} composition: duplicate name ${region.name}`);
    names.add(region.name);
    const regionWhere = `${where} composition region ${region.name}`;
    if (region.kind === "document") {
      only(regionWhere, region, ["name", "kind", "input"]);
      if (region.input !== "native") throw new Error(`${regionWhere}: document input must be native`);
      continue;
    }
    if (region.kind === "image") {
      only(regionWhere, region, ["name", "kind", "sidecar", "input"]);
      if (region.input !== "dom") throw new Error(`${regionWhere}: image input must be dom`);
      if (typeof region.sidecar !== "string" || !sidecars.includes(region.sidecar)) {
        throw new Error(`${regionWhere}: sidecar must be declared by the plugin`);
      }
      continue;
    }
    throw new Error(`${regionWhere}: kind must be document or image`);
  }
  for (const overlay of composition.overlays) {
    if (typeof overlay !== "string" || !REGION.test(overlay)) {
      throw new Error(`${where} composition: invalid overlay name ${overlay}`);
    }
    if (names.has(overlay)) throw new Error(`${where} composition: duplicate name ${overlay}`);
    names.add(overlay);
  }
}

function checkBackground(where, background, sidecars, settings = {}) {
  if (!isObject(background)) throw new Error(`${where}: background must be an object`);
  only(`${where} background`, background, ["sidecar", "operation", "settings"]);
  // settings 는 요청 필드 이름에서 이 플러그인이 선언한 설정 이름으로의 대응이다. 코어는 세션을 열 때 그 설정의
  // 값을 요청 필드에 넣는다.
  if (background.settings !== undefined) {
    if (!isObject(background.settings)) throw new Error(`${where} background: settings must map request fields to setting names`);
    for (const [field, setting] of Object.entries(background.settings)) {
      if (field === "operation") throw new Error(`${where} background: a setting cannot replace operation`);
      if (typeof setting !== "string" || !Object.hasOwn(settings ?? {}, setting)) {
        throw new Error(`${where} background: setting ${setting} is not declared by the plugin`);
      }
    }
  }
  if (typeof background.sidecar !== "string" || !sidecars.includes(background.sidecar)) {
    throw new Error(`${where} background: sidecar must be declared by the plugin`);
  }
  if (typeof background.operation !== "string" || background.operation.length === 0) {
    throw new Error(`${where} background: operation must be a non-empty string`);
  }
}

/**
 * plugin.json 하나를 검사한다. 형식이 틀리면 예외를 던지고, 맞으면 받은 값을 반환한다.
 *
 *   id        플러그인 id. 탭과 설정이 이 값을 참조한다
 *   name      화면에 표시할 이름
 *   mark      `+` 메뉴와 탭 제목에 표시할 짧은 표식. surface 가 있으면 필수
 *   icon      16×16 뷰박스 SVG 요소. surface 가 있으면 필수
 *   surface   카드 표면. `{ page, composition }` 은 패키지 안 문서와 합성 권한 선언이다
 *   home      표면 페이지가 처음 여는 http 또는 https 주소. page 표면이 있어야 한다
 *   sections  사이드바에 표시할 수 있는 섹션. id 는 `<플러그인 id>.<이름>` 형식
 *   preview   라이브러리 미리보기의 색. `ink` 는 테마 토큰 이름(`--rail` 등). surface 가 있어야 한다
 *   sidecars  표면 페이지가 사용하는 사이드카 패키지 이름. 플러그인 package.json 의 의존성이어야 한다
 *   exposes   표면 페이지가 등록하는 status, command, dom 항목. page 표면이 있어야 한다
 */
export function validateManifest(manifest) {
  if (!isObject(manifest)) throw new Error("plugin.json: expected an object");
  only("plugin.json", manifest, ["id", "name", "mark", "icon", "surface", "home", "sections", "preview", "sidecars", "background", "exposes", "settings"]);
  const { id } = manifest;
  if (typeof id !== "string" || !ID.test(id)) throw new Error(`plugin.json: invalid id ${id}`);
  const where = `plugin ${id}`;
  if (!isText(manifest.name)) throw new Error(`${where}: name is required`);
  if (manifest.sidecars !== undefined) {
    if (manifest.surface === undefined) throw new Error(`${where}: sidecars require a surface`);
    checkSidecars(`${where} sidecars`, manifest.sidecars);
  }
  if (manifest.background !== undefined) {
    if (manifest.surface === undefined) throw new Error(`${where}: background requires a surface`);
    checkBackground(`${where}`, manifest.background, manifest.sidecars ?? [], manifest.settings);
  }
  if (manifest.surface !== undefined) {
    const surface = manifest.surface;
    if (!isObject(surface)) throw new Error(`${where}: surface must be an object`);
    only(`${where} surface`, surface, ["module", "composition", "drop"]);
    // 놓기 명령은 파일이 표면에 놓였을 때 페이지가 그 표면에서 {urls} 로 실행하는 선언된 명령이다.
    if (surface.drop !== undefined && (!isText(surface.drop) ||
      !(manifest.exposes?.commands ?? []).some((command) => command.name === surface.drop))) {
      throw new Error(`${where}: surface drop must name a command declared in exposes`);
    }
    if (!isText(surface.module)) throw new Error(`${where}: surface requires a module`);
    if (surface.module.startsWith("/") || surface.module.split("/").includes("..") || !surface.module.endsWith(".js")) {
      throw new Error(`${where}: surface module must be a JavaScript path inside the package`);
    }
    if (surface.composition === undefined) throw new Error(`${where}: surface requires a composition`);
    checkComposition(`${where} surface`, surface.composition, manifest.sidecars ?? []);
    if (!isText(manifest.mark)) throw new Error(`${where}: mark is required with a surface`);
    if (!isText(manifest.icon)) throw new Error(`${where}: icon is required with a surface`);
  }
  if (manifest.sections !== undefined) {
    if (!Array.isArray(manifest.sections)) throw new Error(`${where}: sections must be an array`);
    const seen = new Set();
    for (const section of manifest.sections) {
      if (!isObject(section)) throw new Error(`${where}: section must be an object`);
      only(`${where} section`, section, ["id", "name"]);
      if (typeof section.id !== "string" || !section.id.startsWith(`${id}.`) || !ID.test(section.id.slice(id.length + 1))) {
        throw new Error(`${where}: section id ${section.id} must be ${id}.<name>`);
      }
      if (seen.has(section.id)) throw new Error(`${where}: duplicate section ${section.id}`);
      seen.add(section.id);
      if (!isText(section.name)) throw new Error(`${where}: section ${section.id} requires a name`);
    }
  }
  if (manifest.preview !== undefined) {
    if (manifest.surface === undefined) throw new Error(`${where}: preview requires a surface`);
    if (!isObject(manifest.preview)) throw new Error(`${where}: preview must be an object`);
    only(`${where} preview`, manifest.preview, ["ink"]);
    if (typeof manifest.preview.ink !== "string" || !TOKEN.test(manifest.preview.ink)) {
      throw new Error(`${where}: preview.ink must be a theme token name`);
    }
  }
  if (manifest.home !== undefined) {
    if (manifest.surface === undefined) throw new Error(`${where}: home requires a surface`);
    if (!isText(manifest.home) || !/^https?:\/\/[^/]/.test(manifest.home)) {
      throw new Error(`${where}: home must be an http or https address`);
    }
  }
  if (manifest.exposes !== undefined) {
    if (manifest.surface === undefined) throw new Error(`${where}: exposes require a surface`);
    validateExposes(id, manifest.exposes);
  }
  checkSettings(`${where}`, manifest.settings);
  if (manifest.surface === undefined && manifest.sections === undefined) {
    throw new Error(`${where}: a plugin requires a surface or sections`);
  }
  return manifest;
}

/**
 * sidecar.json 하나를 검사한다. 형식이 틀리면 예외를 던지고, 맞으면 받은 값을 반환한다.
 *
 *   executable  빌드된 실행 파일의 패키지 안 경로. 네이티브 호스트는 이 파일 이름으로
 *               애플리케이션 실행 파일과 같은 디렉터리에서 찾는다
 *   protocol    메시지 형식 버전. 현재 1
 *   helpers     선택 필드. 사이드카가 사용하는 헬퍼 패키지 목록
 */
export function validateSidecar(sidecar) {
  if (!isObject(sidecar)) throw new Error("sidecar.json: expected an object");
  only("sidecar.json", sidecar, ["executable", "protocol", "helpers", "transport"]);
  const { executable } = sidecar;
  if (!isText(executable) || executable.startsWith("/") || executable.split("/").includes("..")) {
    throw new Error("sidecar.json: executable must be a path inside the package");
  }
  if (sidecar.protocol !== 1) throw new Error("sidecar.json: protocol must be 1");
  if (sidecar.transport !== undefined && sidecar.transport !== "persistent") {
    throw new Error("sidecar.json: transport must be persistent");
  }
  if (sidecar.helpers !== undefined) {
    if (!Array.isArray(sidecar.helpers)) throw new Error("sidecar.json: helpers must be an array");
    // 호스트는 실행 파일을 파일 이름으로 찾으므로 한 사이드카가 같은 이름을 두 번 요구할 수 없다.
    const names = new Set([executable.split("/").pop()]);
    for (const helper of sidecar.helpers) {
      if (!isObject(helper)) throw new Error("sidecar.json helpers: expected an object");
      only("sidecar.json helpers", helper, ["package", "executable"]);
      if (!isText(helper.package) || !PACKAGE.test(helper.package)) {
        throw new Error("sidecar.json helpers: package must be a package name");
      }
      const path = helper.executable;
      if (!isText(path) || path.startsWith("/") || path.split("/").includes("..")) {
        throw new Error("sidecar.json helpers: executable must be a path inside the package");
      }
      const file = path.split("/").pop();
      if (names.has(file)) throw new Error(`sidecar.json helpers: ${file} is declared twice`);
      names.add(file);
    }
  }
  return sidecar;
}

/**
 * environment.json 하나를 검사한다. 형식이 틀리면 예외를 던지고, 맞으면 받은 값을 반환한다.
 *
 *   runtime    런타임 모듈 디렉터리. 애플리케이션 디렉터리 기준 경로이고 index.js 를 포함한다
 *   plugins    불러올 플러그인 패키지 이름. 순서가 `+` 메뉴 순서다
 *   workspace  새 스페이스의 배치. focus 는 포커스할 카드 id, grid 는 선과 카드
 *   sidebars   사이드바 세트(sets)와 자리 연결(links)의 기본값
 *
 * 플러그인 id 와 섹션 id 의 참조는 manifest 를 불러온 뒤 checkReferences 로 검사한다.
 */
export function validateEnvironment(environment) {
  if (!isObject(environment)) throw new Error("environment.json: expected an object");
  only("environment.json", environment, ["runtime", "plugins", "workspace", "sidebars", "settings"]);
  if (!isText(environment.runtime) || environment.runtime.startsWith("/") || environment.runtime.split("/").includes("..")) {
    throw new Error("environment.json: runtime must be a directory inside the application");
  }
  if (!Array.isArray(environment.plugins) || environment.plugins.some((name) => typeof name !== "string" || !PACKAGE.test(name))) {
    throw new Error("environment.json: plugins must be package names");
  }
  if (new Set(environment.plugins).size !== environment.plugins.length) {
    throw new Error("environment.json: duplicate plugin package");
  }
  if (environment.settings !== undefined && !isObject(environment.settings)) {
    throw new Error("environment.json: settings must be an object");
  }
  const { workspace } = environment;
  if (!isObject(workspace)) throw new Error("environment.json: workspace is required");
  only("environment.json workspace", workspace, ["focus", "grid"]);
  const { grid } = workspace;
  if (!isObject(grid) || !Array.isArray(grid.xs) || !Array.isArray(grid.ys) || !Array.isArray(grid.cards)) {
    throw new Error("environment.json: workspace.grid requires xs, ys, and cards");
  }
  only("environment.json workspace.grid", grid, ["xs", "ys", "cards"]);
  for (const card of grid.cards) {
    if (!isObject(card) || !isText(card.id)) throw new Error("environment.json: every card requires an id");
    only(`environment.json card ${card.id}`, card, ["id", "c0", "c1", "r0", "r1", "width", "fixed", "tabs"]);
    if (card.tabs !== undefined) {
      if (!Array.isArray(card.tabs) || card.tabs.length === 0) {
        throw new Error(`environment.json: card ${card.id} tabs must be a non-empty array`);
      }
      for (const tab of card.tabs) {
        if (!isObject(tab) || !isText(tab.plugin) || !isText(tab.title)) {
          throw new Error(`environment.json: card ${card.id} tabs require plugin and title`);
        }
        only(`environment.json card ${card.id} tab`, tab, ["plugin", "title"]);
      }
    }
  }
  if (!grid.cards.some((card) => card.id === workspace.focus && card.tabs)) {
    throw new Error("environment.json: workspace.focus must name a card with tabs");
  }
  const { sidebars } = environment;
  if (!isObject(sidebars) || !Array.isArray(sidebars.sets) || !Array.isArray(sidebars.links)) {
    throw new Error("environment.json: sidebars requires sets and links");
  }
  only("environment.json sidebars", sidebars, ["sets", "links"]);
  const setIds = new Set();
  for (const set of sidebars.sets) {
    if (!isObject(set) || !isText(set.id) || !isText(set.title) || !Array.isArray(set.sections)) {
      throw new Error("environment.json: every set requires id, title, and sections");
    }
    only(`environment.json set ${set.id}`, set, ["id", "title", "sections"]);
    if (setIds.has(set.id)) throw new Error(`environment.json: duplicate set ${set.id}`);
    setIds.add(set.id);
  }
  for (const link of sidebars.links) {
    if (!isObject(link) || !["left", "right", "rail"].includes(link.place) || !setIds.has(link.set)) {
      throw new Error("environment.json: every link requires a place (left, right, rail) and a known set");
    }
    only("environment.json link", link, ["place", "plugin", "set"]);
    if ((link.place === "left") !== (link.plugin === null)) {
      throw new Error("environment.json: a left link has plugin null and other links name a plugin");
    }
  }
  return environment;
}

/**
 * environment.json 이 참조하는 플러그인 id 와 섹션 id 가 불러온 manifest 에 있는지
 * 검사한다. 없으면 예외를 던진다.
 */
export function checkReferences(environment, manifests) {
  const cards = new Set(manifests.filter((m) => m.surface).map((m) => m.id));
  const sections = new Set(manifests.flatMap((m) => (m.sections ?? []).map((s) => s.id)));
  const ids = manifests.map((m) => m.id);
  if (new Set(ids).size !== ids.length) throw new Error("environment.json: two plugins declare the same id");
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  for (const [pluginId, values] of Object.entries(environment.settings ?? {})) {
    const manifest = byId.get(pluginId);
    if (!manifest) throw new Error(`environment.json: settings names unknown plugin ${pluginId}`);
    if (!isObject(values)) throw new Error(`environment.json: settings for ${pluginId} must be an object`);
    const declarations = manifest.settings ?? {};
    for (const [key, value] of Object.entries(values)) {
      const declaration = declarations[key];
      if (!declaration) throw new Error(`environment.json: settings names unknown key ${pluginId}.${key}`);
      checkSettingValue(`environment.json: settings ${pluginId}.${key}`, declaration, value);
    }
  }
  for (const card of environment.workspace.grid.cards) {
    for (const tab of card.tabs ?? []) {
      if (!cards.has(tab.plugin)) throw new Error(`environment.json: tab plugin ${tab.plugin} has no surface`);
    }
  }
  for (const set of environment.sidebars.sets) {
    for (const id of set.sections) {
      if (!sections.has(id)) throw new Error(`environment.json: set ${set.id} names unknown section ${id}`);
    }
  }
  for (const link of environment.sidebars.links) {
    if (link.plugin !== null && !cards.has(link.plugin)) {
      throw new Error(`environment.json: link names plugin ${link.plugin} without a surface`);
    }
  }
}

/* ── 공개 항목(exposure) ─────────────────────────────────────────────────
   코어와 플러그인이 외부 클라이언트에 공개하는 status, command, dom 항목의 선언
   형식과, 문서 안에서 등록된 항목에 요청을 적용하는 함수. 명세는
   docs/spec/exposure.md 에 있다. */

/** 선언 파일의 키와 등록 종류. 선언은 commands 로, 등록과 목록은 command 로 적는다. */
export const EXPOSE_KINDS = Object.freeze({ status: "status", commands: "command", dom: "dom" });

/** 요청 실패의 코드. */
export const EXPOSURE_ERRORS = Object.freeze({
  failed: -32000,
  unknownMethod: -32601,
  invalidParams: -32602,
  unknownName: 1001,
  unregistered: 1002,
  gone: 1003,
  unavailable: 1004,
  timeout: 1005,
  inactive: 1006,
});

const OWNER = /^(core|host|[a-z][a-z0-9-]*)$/;
const NAME = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SCHEMA_TYPES = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  object: isObject,
  array: Array.isArray,
  null: (v) => v === null,
};

/** 스키마 하나를 검사한다. 허용하는 키워드는 type, properties, items, enum 이다. */
function checkSchema(where, schema) {
  if (!isObject(schema)) throw new Error(`${where}: schema must be an object`);
  only(where, schema, ["type", "properties", "items", "enum"]);
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (types.length === 0 || types.some((type) => !Object.hasOwn(SCHEMA_TYPES, type))) {
      throw new Error(`${where}: unknown schema type ${JSON.stringify(schema.type)}`);
    }
  }
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) throw new Error(`${where}: properties must be an object`);
    for (const [key, value] of Object.entries(schema.properties)) checkSchema(`${where}.${key}`, value);
  }
  if (schema.items !== undefined) checkSchema(`${where}[]`, schema.items);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new Error(`${where}: enum must be a non-empty array`);
  }
}

/**
 * 값이 스키마를 만족하는지 반환한다. properties 는 값에 있는 키만 검사한다.
 */
export function matchesSchema(schema, value) {
  if (schema.enum !== undefined && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) return false;
  if (schema.type !== undefined && ![].concat(schema.type).some((type) => SCHEMA_TYPES[type](value))) return false;
  if (schema.properties !== undefined && isObject(value)) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key) && !matchesSchema(sub, value[key])) return false;
    }
  }
  if (schema.items !== undefined && Array.isArray(value)) return value.every((item) => matchesSchema(schema.items, item));
  return true;
}

/**
 * `exposes` 선언 하나를 검사한다. 형식이 틀리면 예외를 던지고, 맞으면 받은 값을 반환한다.
 *
 *   owner   이름의 앞부분. core, host, 또는 플러그인 id
 *   status  {name, description, schema}
 *   commands {name, description, params, result, timeout?}. params 는 type object 스키마다.
 *           timeout 은 호스트가 표면의 답을 기다리는 시간(ms, 1–600000)이다
 *   dom     {name, description, many?}
 *
 * 이름은 `<owner>.<name>` 이고 소문자, 숫자, 점, 하이픈으로 이루어진다. 한 종류 안에서
 * 같은 이름은 한 번만 선언한다. 종류가 다르면 같은 이름을 쓸 수 있다.
 */
/** 명령 선언의 timeout 상한(ms). */
export const COMMAND_TIMEOUT_MAX = 600000;

export function validateExposes(owner, exposes) {
  if (typeof owner !== "string" || !OWNER.test(owner)) throw new Error(`exposes: invalid owner ${owner}`);
  const where = `${owner} exposes`;
  if (!isObject(exposes)) throw new Error(`${where}: expected an object`);
  only(where, exposes, Object.keys(EXPOSE_KINDS));
  const seen = new Set();
  const fields = { status: ["schema"], commands: ["params", "result"], dom: [] };
  for (const [key, entries] of Object.entries(exposes)) {
    if (!Array.isArray(entries)) throw new Error(`${where}: ${key} must be an array`);
    for (const entry of entries) {
      if (!isObject(entry)) throw new Error(`${where}: ${key} entry must be an object`);
      const { name } = entry;
      if (typeof name !== "string" || !name.startsWith(`${owner}.`) || !NAME.test(name)) {
        throw new Error(`${where}: name ${name} must be ${owner}.<name> with lowercase letters, digits, dots, and hyphens`);
      }
      if (seen.has(`${key} ${name}`)) throw new Error(`${where}: duplicate ${key} ${name}`);
      seen.add(`${key} ${name}`);
      const at = `${where} ${name}`;
      only(at, entry, ["name", "description", ...fields[key], ...(key === "dom" ? ["many"] : []),
        ...(key === "commands" ? ["timeout"] : [])]);
      if (!isText(entry.description)) throw new Error(`${at}: description is required`);
      for (const field of fields[key]) {
        if (entry[field] === undefined) throw new Error(`${at}: ${field} is required`);
        checkSchema(`${at} ${field}`, entry[field]);
      }
      if (key === "commands" && entry.params.type !== "object") throw new Error(`${at}: params must be an object schema`);
      if (entry.many !== undefined && typeof entry.many !== "boolean") throw new Error(`${at}: many must be a boolean`);
      if (entry.timeout !== undefined
        && !(Number.isInteger(entry.timeout) && entry.timeout >= 1 && entry.timeout <= COMMAND_TIMEOUT_MAX)) {
        throw new Error(`${at}: timeout must be an integer from 1 to ${COMMAND_TIMEOUT_MAX} milliseconds`);
      }
    }
  }
  return exposes;
}

/**
 * 플러그인의 diagnostics.json 을 manifest 와 함께 검사한다. `{module, exposes}` 이며 module 은
 * 패키지 안의 JavaScript 경로, exposes 는 plugin.json exposes 와 같은 형식이다. 표면이 있는
 * 플러그인만 가질 수 있고, 한 이름은 plugin.json 과 diagnostics.json 중 한 곳에만 선언한다.
 */
export function validateDiagnostics(manifest, diagnostics) {
  const where = `plugin ${manifest.id} ${DIAGNOSTICS}`;
  if (manifest.surface === undefined) throw new Error(`${where}: diagnostics require a surface`);
  if (!isObject(diagnostics)) throw new Error(`${where}: expected an object`);
  only(where, diagnostics, ["module", "exposes"]);
  const { module } = diagnostics;
  if (!isText(module) || module.startsWith("/") || module.split("/").includes("..") || !module.endsWith(".js")) {
    throw new Error(`${where}: module must be a JavaScript path inside the package`);
  }
  validateExposes(manifest.id, diagnostics.exposes);
  mergeExposes(manifest.exposes ?? {}, diagnostics.exposes);
  return diagnostics;
}

/** 두 exposes 선언을 합친다. 같은 종류의 같은 이름이 두 곳에 있으면 예외를 던진다. */
export function mergeExposes(first, second) {
  declarationMap(second, declarationMap(first));
  return Object.fromEntries(Object.keys(EXPOSE_KINDS)
    .filter((key) => first[key] !== undefined || second[key] !== undefined)
    .map((key) => [key, [...(first[key] ?? []), ...(second[key] ?? [])]]));
}

/**
 * 스테이징된 diagnostic-plugins.json 을 검사한다. 키는 environment 의 플러그인 패키지 이름이고
 * 값은 그 플러그인의 diagnostics.json 내용이다. manifests 는 패키지 이름에서 manifest 로의 Map 이다.
 */
export function validateDiagnosticPlugins(file, manifests) {
  if (!isObject(file)) throw new Error(`${DIAGNOSTIC_PLUGINS}: expected an object`);
  for (const [name, diagnostics] of Object.entries(file)) {
    const manifest = manifests.get(name);
    if (!manifest) throw new Error(`${DIAGNOSTIC_PLUGINS}: ${name} is not a plugin of the environment`);
    validateDiagnostics(manifest, diagnostics);
  }
  return file;
}

/** 코어 선언 파일(exposure.json) 하나를 검사한다. 이름의 owner 는 core 다. */
export function validateExposureFile(file) {
  if (!isObject(file)) throw new Error(`${EXPOSURE}: expected an object`);
  only(EXPOSURE, file, ["exposes"]);
  validateExposes("core", file.exposes);
  return file;
}

/** 요청 메서드가 다루는 항목 종류. */
export const METHOD_KINDS = Object.freeze({
  "status.get": "status", "status.watch": "status", "status.unwatch": "status", "status.next": "status",
  "command.run": "command", "dom.rect": "dom", "dom.act": "dom",
});

/** 선언 Map 의 키. 종류와 이름의 쌍이다. */
export const declarationKey = (kind, name) => `${kind} ${name}`;

/**
 * 선언을 declarationKey(kind, name) 에서 {kind, declaration} 으로 찾는 Map 으로 바꾼다.
 * 이미 있는 키면 예외를 던진다.
 */
export function declarationMap(exposes, into = new Map()) {
  for (const [key, kind] of Object.entries(EXPOSE_KINDS)) {
    for (const declaration of exposes[key] ?? []) {
      const at = declarationKey(kind, declaration.name);
      if (into.has(at)) throw new Error(`${kind} ${declaration.name} is declared twice`);
      into.set(at, { kind, declaration });
    }
  }
  return into;
}

/** 스테이징된 문서 경로에서 그 문서를 담은 패키지 이름을 반환한다. 모듈 경로가 아니면 null. */
export function pagePackage(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "modules") return null;
  const name = parts[1]?.startsWith("@") ? parts.slice(1, 3).join("/") : parts[1];
  return name && PACKAGE.test(name) ? name : null;
}

/** 코드를 가진 요청 실패. 호출자는 {error: {code, message}} 로 답한다. */
export class ExposureError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 요소의 사각형. 요소가 속한 문서의 뷰포트 기준 CSS 픽셀이다. */
export function elementRect(element) {
  const r = element.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

const KEYBOARD = /^key/;
const POINTER = /^pointer/;
const MOUSE = /^(mouse|click$|dblclick$|contextmenu$)/;

/**
 * 요소에 합성 DOM 이벤트를 보낸다. 페이지는 isTrusted 가 false 인 이벤트를 받는다.
 *
 *   click     element.click()
 *   input     value 를 설정하고 input 과 change 를 보낸다
 *   dispatch  event = {type, ...init}. type 에 따라 KeyboardEvent, PointerEvent,
 *             MouseEvent, Event 를 만든다. bubbles 의 기본값은 true 다
 */
export function actOn(element, { action, value, event }) {
  const view = element.ownerDocument.defaultView;
  if (action === "click") {
    element.click();
    return null;
  }
  if (action === "input") {
    if (typeof value !== "string") throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "input requires a string value");
    element.value = value;
    element.dispatchEvent(new view.Event("input", { bubbles: true }));
    element.dispatchEvent(new view.Event("change", { bubbles: true }));
    return null;
  }
  if (action === "dispatch") {
    if (!isObject(event) || !isText(event.type)) {
      throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "dispatch requires event.type");
    }
    const { type, ...init } = event;
    const Kind = KEYBOARD.test(type) ? view.KeyboardEvent
      : POINTER.test(type) ? (view.PointerEvent ?? view.MouseEvent)
        : MOUSE.test(type) ? view.MouseEvent : view.Event;
    element.dispatchEvent(new Kind(type, { bubbles: true, cancelable: true, ...init }));
    return null;
  }
  throw new ExposureError(EXPOSURE_ERRORS.invalidParams, `unknown action ${action}`);
}

/**
 * 한 문서에 등록된 항목. 선언(declarationMap 의 결과)에 없는 이름은 등록하지 못한다.
 *
 * status 의 감시는 두 방법으로 전달한다. watch 의 changed(value) 는 값이 바뀔 때마다
 * 호출되고, status.next 는 요청의 version 보다 새 값이 생기면 {version, value} 로
 * 답한다. 감시가 끝나면 기다리던 status.next 는 {closed: true} 로 답한다.
 */
export function exposureEntries(declared) {
  const statuses = new Map();
  const commands = new Map();
  const doms = new Map();
  const tables = { status: statuses, command: commands, dom: doms };

  const declaration = (kind, name) => {
    const found = declared.get(declarationKey(kind, name));
    if (!found) throw new Error(`${kind} ${name} is not declared`);
    return found.declaration;
  };

  const elements = (name) => (doms.get(name) ?? []).flatMap((provide) => provide()).filter((el) => el.isConnected !== false);

  function status(name) {
    const entry = statuses.get(name);
    if (!entry) throw new ExposureError(EXPOSURE_ERRORS.unregistered, `status ${name} is not registered`);
    return entry;
  }

  function stop(entry) {
    entry.watching = false;
    const stopper = entry.stop;
    entry.stop = null;
    if (typeof stopper === "function") stopper();
    for (const resolve of entry.waiters.splice(0)) resolve({ closed: true });
  }

  function update(entry, value, changed) {
    if (!entry.watching) return;
    const text = JSON.stringify(value ?? null);
    if (text === entry.text) return;
    entry.text = text;
    entry.value = value ?? null;
    entry.version++;
    for (const resolve of entry.waiters.splice(0)) resolve({ version: entry.version, value: entry.value });
    changed(entry.value);
  }

  return {
    declared,

    /** 이름이 이 문서에 등록되어 있는지. dom 은 연결된 요소가 있을 때 등록된 것이다. */
    registered(kind, name) {
      return kind === "dom" ? elements(name).length > 0 : tables[kind].has(name);
    },

    status(name, read, subscribe) {
      declaration("status", name);
      if (statuses.has(name)) throw new Error(`status ${name} is already registered`);
      if (typeof read !== "function" || typeof subscribe !== "function") {
        throw new Error(`status ${name} requires read and subscribe functions`);
      }
      statuses.set(name, { read, subscribe, watching: false, stop: null, text: undefined, value: null, version: 0, waiters: [] });
    },

    command(name, run) {
      declaration("command", name);
      if (commands.has(name)) throw new Error(`command ${name} is already registered`);
      if (typeof run !== "function") throw new Error(`command ${name} requires a function`);
      commands.set(name, run);
    },

    /** provide 는 요소 배열을 반환하는 함수다. many 가 아니면 한 번만 등록한다. */
    dom(name, provide) {
      const { many } = declaration("dom", name);
      if (!many && doms.has(name)) throw new Error(`dom ${name} is already registered`);
      doms.set(name, [...(doms.get(name) ?? []), provide]);
    },

    /** 이 문서의 등록을 모두 해제한다. 감시도 끝낸다. */
    clear() {
      for (const entry of statuses.values()) stop(entry);
      statuses.clear();
      commands.clear();
      doms.clear();
    },

    /**
     * 요청 하나를 처리하고 결과를 반환한다. 실패하면 ExposureError 를 던진다.
     * changed(name, value) 는 감시 중인 status 의 값이 바뀔 때 호출된다.
     */
    async answer(method, params, changed = () => {}) {
      const kind = METHOD_KINDS[method];
      if (!kind) throw new ExposureError(EXPOSURE_ERRORS.unknownMethod, `unknown method ${method}`);
      if (!isObject(params) || typeof params.name !== "string") {
        throw new ExposureError(EXPOSURE_ERRORS.invalidParams, `${method} requires name`);
      }
      const { name } = params;
      const found = declared.get(declarationKey(kind, name));
      if (!found) throw new ExposureError(EXPOSURE_ERRORS.unknownName, `unknown ${kind} ${name}`);
      if (method === "status.get") return (await status(name).read()) ?? null;
      if (method === "status.watch") {
        const entry = status(name);
        if (entry.watching) return null;
        entry.watching = true;
        const listen = (value) => update(entry, value, (v) => changed(name, v));
        entry.stop = entry.subscribe(listen);
        listen(await entry.read());
        return null;
      }
      if (method === "status.unwatch") {
        const entry = statuses.get(name);
        if (entry) stop(entry);
        return null;
      }
      if (method === "status.next") {
        const entry = status(name);
        if (!entry.watching) return { closed: true };
        if (entry.version > (params.version ?? 0)) return { version: entry.version, value: entry.value };
        return new Promise((resolve) => entry.waiters.push(resolve));
      }
      if (method === "command.run") {
        const run = commands.get(name);
        if (!run) throw new ExposureError(EXPOSURE_ERRORS.unregistered, `command ${name} is not registered`);
        const input = params.params ?? {};
        if (!matchesSchema(found.declaration.params, input)) {
          throw new ExposureError(EXPOSURE_ERRORS.invalidParams, `invalid params for ${name}`);
        }
        return (await run(input)) ?? null;
      }
      const list = elements(name);
      if (list.length === 0) throw new ExposureError(EXPOSURE_ERRORS.unregistered, `dom ${name} has no element`);
      if (!found.declaration.many && list.length > 1) {
        throw new ExposureError(EXPOSURE_ERRORS.unregistered, `dom ${name} has ${list.length} elements`);
      }
      const index = params.index ?? 0;
      if (!Number.isInteger(index) || index < 0) throw new ExposureError(EXPOSURE_ERRORS.invalidParams, "index must be a non-negative integer");
      const element = list[index];
      if (!element) throw new ExposureError(EXPOSURE_ERRORS.unregistered, `dom ${name} has no element at index ${index}`);
      if (method === "dom.rect") return elementRect(element);
      return actOn(element, params);
    },
  };
}

/** 요청 처리 결과를 relay 의 답 형식 {result} 또는 {error: {code, message}} 로 바꾼다. */
export async function replyPayload(work) {
  try {
    return { result: (await work()) ?? null };
  } catch (error) {
    // 등록한 함수가 던진 일반 예외는 요청 형식이 아니라 실행의 실패다.
    const code = error instanceof ExposureError ? error.code : EXPOSURE_ERRORS.failed;
    return { error: { code, message: String(error?.message ?? error) } };
  }
}

/**
 * 표면 페이지의 공개 항목 등록.
 *
 * port 는 런타임의 page.exposure 이고 load 는 manifest 형식의 선언 묶음 또는 선언 Map 을
 * 반환하는 함수다. 선언은 첫 등록에서 한 번 읽는다. 등록은 선언을 읽은 뒤 이루어지고,
 * 선언되지 않은 이름이면 반환한 promise 가 거절된다. 메인 페이지가 전달한 요청에는
 * 이 문서에 등록된 항목으로 답한다.
 *
 * 감시는 메인 페이지가 정한 경로로 전달한다. 메인 페이지는 status.watch 를 전달한 뒤
 * status.next {name, version} 을 반복해서 전달하고, 이 문서는 version 보다 새 값이
 * 생기면 {version, value} 로 답한다.
 */
export function createExpose(port, load) {
  let entries = null;
  let loaded = null;
  const ready = () => {
    entries ??= Promise.resolve().then(load).then(async (declarations) => {
      // Manifest files carry grouped arrays; the request path needs the canonical
      // declaration map used by the registry and exposureEntries.
      const declared = declarations instanceof Map ? declarations : declarationMap(declarations);
      const made = exposureEntries(declared);
      loaded = made;
      await port.onRequest(({ id, method, params }) => {
        replyPayload(() => made.answer(method, params)).then((payload) => port.reply(id, payload));
      });
      return made;
    });
    return entries;
  };
  const registered = new Set();
  const register = async (kind, name, add) => {
    add(await ready());
    const key = declarationKey(kind, name);
    if (registered.has(key)) return;
    registered.add(key);
    await port.register(kind, name);
  };
  const bindings = new Set();
  const binder = createBinder((name, params) => ready().then((e) => e.answer("command.run", { name, params })), {
    check(name) {
      if (!loaded?.declared.has(declarationKey("command", name))) throw new Error(`command ${name} is not declared`);
    },
    changed: () => { for (const fn of bindings) fn(); },
  });
  /* 연결은 선언을 읽은 뒤 한다. 선언되지 않은 명령이면 반환한 promise 가 거절된다. */
  const binding = (fn) => async (...args) => {
    await ready();
    return fn(...args);
  };
  return {
    /** 요소를 이 문서에 등록된 명령에 연결한다. createBinder 의 bind, mark, delegate 다. */
    bind: binding(binder.bind),
    mark: binding(binder.mark),
    delegate: binding(binder.delegate),
    /** 이 문서에 선언된 명령을 레지스트리로 실행한다. */
    run: binding(binder.run),
    /** root 안에서 명령이나 dom 이름이 없는 조작 요소. */
    audit: (root) => binder.audit(root),
    /** 연결이 바뀌면 fn 을 호출한다. 해제 함수를 반환한다. */
    onBinding(fn) {
      bindings.add(fn);
      return () => bindings.delete(fn);
    },
    status: (name, read, subscribe) => register("status", name, (e) => e.status(name, read, subscribe)),
    command: (name, run) => register("command", name, (e) => e.command(name, run)),
    dom: (name, element) => register("dom", name, (e) => {
      e.dom(name, () => [element]);
      element.dataset.expose = name;
    }),
    dispose: async () => {
      binder.dispose();
      loaded?.clear();
      registered.clear();
      await port.unregister?.();
    },
  };
}
