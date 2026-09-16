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
export const ENVIRONMENT = "environment.json";
export const MANIFEST = "plugin.json";
export const RUNTIME = "runtime";

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

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.length > 0;

function only(where, value, keys) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${where}: unknown field ${key}`);
  }
}

/**
 * plugin.json 하나를 검사한다. 형식이 틀리면 예외를 던지고, 맞으면 받은 값을 반환한다.
 *
 *   id        플러그인 id. 탭과 설정이 이 값을 참조한다
 *   name      화면에 표시할 이름
 *   mark      `+` 메뉴와 탭 제목에 표시할 짧은 표식. surface 가 있으면 필수
 *   icon      16×16 뷰박스 SVG 요소. surface 가 있으면 필수
 *   surface   카드 표면. `{ url }` 은 외부 주소, `{ page }` 는 패키지 안의 문서 경로
 *   sections  사이드바에 표시할 수 있는 섹션. id 는 `<플러그인 id>.<이름>` 형식
 */
export function validateManifest(manifest) {
  if (!isObject(manifest)) throw new Error("plugin.json: expected an object");
  only("plugin.json", manifest, ["id", "name", "mark", "icon", "surface", "sections"]);
  const { id } = manifest;
  if (typeof id !== "string" || !ID.test(id)) throw new Error(`plugin.json: invalid id ${id}`);
  const where = `plugin ${id}`;
  if (!isText(manifest.name)) throw new Error(`${where}: name is required`);
  if (manifest.surface !== undefined) {
    const surface = manifest.surface;
    if (!isObject(surface)) throw new Error(`${where}: surface must be an object`);
    only(`${where} surface`, surface, ["url", "page"]);
    const kinds = ["url", "page"].filter((key) => key in surface);
    if (kinds.length !== 1 || !isText(surface[kinds[0]])) {
      throw new Error(`${where}: surface requires exactly one of url or page`);
    }
    if (surface.url !== undefined && !/^https?:\/\//.test(surface.url)) {
      throw new Error(`${where}: surface url must use http or https`);
    }
    if (surface.page !== undefined && (surface.page.startsWith("/") || surface.page.split("/").includes(".."))) {
      throw new Error(`${where}: surface page must be a path inside the package`);
    }
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
  if (manifest.surface === undefined && manifest.sections === undefined) {
    throw new Error(`${where}: a plugin requires a surface or sections`);
  }
  return manifest;
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
  only("environment.json", environment, ["runtime", "plugins", "workspace", "sidebars"]);
  if (!isText(environment.runtime) || environment.runtime.startsWith("/") || environment.runtime.split("/").includes("..")) {
    throw new Error("environment.json: runtime must be a directory inside the application");
  }
  if (!Array.isArray(environment.plugins) || environment.plugins.some((name) => typeof name !== "string" || !PACKAGE.test(name))) {
    throw new Error("environment.json: plugins must be package names");
  }
  if (new Set(environment.plugins).size !== environment.plugins.length) {
    throw new Error("environment.json: duplicate plugin package");
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
