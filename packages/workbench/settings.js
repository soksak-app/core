// 판 외부의 설정값. 테마, 모드, 형태.
//
// 값이 바뀌면 판의 배치도 바뀌지만 이 모듈은 판을 호출하지 않고 변경만 통지한다.
// 설정이 판을 참조하면 설정을 추가할 때마다 호출할 판의 함수를 정해야 한다.

/* ── 테마 ──────────────────────────────────────────────────────────────────
   축이 둘이다. 테마가 형태와 색을 정하고, 모드가 그 테마의 dark 와 light 중
   하나를 선택한다. 모든 테마는 양쪽 값을 모두 갖는다.

   형태(모서리 반경, 통로 폭, 보더 굵기, 폰트, 글자 크기)는 모드와 무관하다.
   밝기가 바뀐다고 모서리가 바뀔 이유는 없다.

   선의 색은 역할별로 넷이다. 하나의 강조색을 농도만 바꿔 쓰면 무엇이 한 묶음인지
   보이지 않는다.

     edge   카드와 상자의 테두리. 바탕에서 한 단계만 밝다
     rule   판을 나누는 경계선과 divider
     rail   사이드바와 카드를 하나로 묶는 선
     focus  지금 입력을 받는 곳

   통로가 0이면 카드가 서로 붙고 경계선 하나를 두 카드가 공유한다. 그 상태를
   이음새라고 부르며 통로 값에서 나온다. 별도의 설정값을 두지 않는다.

   적용은 값을 루트에 심는 것이다. 표면과 모달은 각자 다른 문서라 이 문서의
   스타일시트를 물려받지 못하므로, 호스트가 이 값들을 그대로 실어 보낸다.     */

import { host as bridge } from "@soksak/runtime";
import { log, surfaces as host } from "./host.js";
import { checkSidebarReferences, isSettingAddress, validateSidebars } from "@soksak/plugin-api";
import { effectiveSettings } from "./settings-scope.js";
import { migrateSettings } from "./settings-migration.js";
import { chooseLink, resolveSidebar } from "./sidebar-sets.js";
import { TEXT_STEPS, notifyTextSize } from "./text-size.js";
import { setTraceEnabled } from "./performance.js";

/* 고를 수 있는 폰트. 테마가 이 중 하나를 기본으로 지정하고 설정에서 바꾼다.
   설치되지 않은 이름은 목록의 다음 이름으로 넘어간다. */
export const FONTS = [
  { id: "mono-system", name: "시스템 고정폭",
    stack: "ui-monospace,SFMono-Regular,Menlo,monospace" },
  { id: "mono-sf", name: "SF Mono / Menlo",
    stack: "'SF Mono',Menlo,'DejaVu Sans Mono',ui-monospace,monospace" },
  { id: "mono-jet", name: "JetBrains Mono",
    stack: "'JetBrains Mono','Fira Code',ui-monospace,monospace" },
  { id: "sans-system", name: "시스템 비례",
    stack: "ui-sans-serif,-apple-system,'Segoe UI',sans-serif" },
  { id: "sans-inter", name: "Inter",
    stack: "Inter,ui-sans-serif,-apple-system,'Segoe UI',sans-serif" },
];

export const THEMES = [
  { name: "midnight", shape: { r: "10px", gap: "6px", bw: "1px", font: "mono-system", size: "13px" },
    dark: { bg: "#101117", card: "#191b24", fg: "#ececf5", muted: "#8f92a4",
            edge: "#2b2e3d", rule: "#22242f", rail: "#7279ff", focus: "#ffb36b",
            no: "#ff7c7c" },
    light: { bg: "#eef0f4", card: "#ffffff", fg: "#252735", muted: "#6c6f7e",
             edge: "#d8dbe4", rule: "#e3e6ec", rail: "#5962e8", focus: "#c06a1f",
             no: "#c62c2c" } },

  { name: "nord", shape: { r: "8px", gap: "5px", bw: "1px", font: "mono-sf", size: "13px" },
    dark: { bg: "#2e3440", card: "#353c4a", fg: "#eceff4", muted: "#8b93a5",
            edge: "#454d5e", rule: "#3a4150", rail: "#81a1c1", focus: "#ebcb8b",
            no: "#bf616a" },
    light: { bg: "#eceff4", card: "#ffffff", fg: "#2e3440", muted: "#6d7789",
             edge: "#d8dee9", rule: "#e3e8ef", rail: "#5e81ac", focus: "#b48a2f",
             no: "#a3454e" } },

  { name: "solar", shape: { r: "6px", gap: "7px", bw: "2px", font: "mono-system", size: "13px" },
    dark: { bg: "#002b36", card: "#05323d", fg: "#eee8d5", muted: "#8b9ea0",
            edge: "#0f4451", rule: "#073642", rail: "#268bd2", focus: "#cb4b16",
            no: "#dc322f" },
    light: { bg: "#fdf6e3", card: "#fffdf6", fg: "#3b4a4f", muted: "#8a9599",
             edge: "#e8dfc4", rule: "#f0e7d0", rail: "#268bd2", focus: "#cb4b16",
             no: "#dc322f" } },

  { name: "forest", shape: { r: "14px", gap: "6px", bw: "1px", font: "sans-system", size: "13px" },
    dark: { bg: "#0e1512", card: "#141d19", fg: "#dfeee6", muted: "#7d9389",
            edge: "#22302a", rule: "#1a241f", rail: "#3f8f6b", focus: "#d9a441",
            no: "#e0736d" },
    light: { bg: "#eef4f0", card: "#ffffff", fg: "#1f3129", muted: "#6b8378",
             edge: "#d4e2da", rule: "#e2ebe6", rail: "#2f7a58", focus: "#a8761f",
             no: "#b1453f" } },

  { name: "ember", shape: { r: "4px", gap: "4px", bw: "2px", font: "mono-jet", size: "13px" },
    dark: { bg: "#17100e", card: "#201714", fg: "#f3e4de", muted: "#a1877e",
            edge: "#33241f", rule: "#271c18", rail: "#c4603a", focus: "#e8a33d",
            no: "#e05252" },
    light: { bg: "#faf0ea", card: "#fffaf6", fg: "#3a2822", muted: "#8d7268",
             edge: "#ecd9cd", rule: "#f3e6dd", rail: "#b1552f", focus: "#a56a17",
             no: "#b23a3a" } },

  /* 통로 0. 카드가 서로 붙고 경계선 하나를 공유한다. */
  { name: "slate", shape: { r: "0px", gap: "0px", bw: "1px", font: "sans-inter", size: "13px" },
    dark: { bg: "#15171a", card: "#1c1f23", fg: "#e6e9ee", muted: "#8d939d",
            edge: "#2c3036", rule: "#2c3036", rail: "#6b7480", focus: "#c7ced8",
            no: "#d97070" },
    light: { bg: "#f1f3f5", card: "#ffffff", fg: "#23282e", muted: "#6f7781",
             edge: "#dcdfe4", rule: "#dcdfe4", rail: "#7b8593", focus: "#3d4854",
             no: "#b1453f" } },

  { name: "mist", shape: { r: "12px", gap: "6px", bw: "1px", font: "mono-system", size: "13px" },
    dark: { bg: "#121821", card: "#18202a", fg: "#e2eaf2", muted: "#7f8fa1",
            edge: "#283344", rule: "#1d2531", rail: "#4c6c88", focus: "#8ec5ea",
            no: "#dd7a74" },
    light: { bg: "#eef2f5", card: "#f9fbfc", fg: "#2b3440", muted: "#71808f",
             edge: "#d5dee6", rule: "#e3eaf0", rail: "#6f92ad", focus: "#2f6f9f",
             no: "#b8453f" } },

  { name: "grape", shape: { r: "16px", gap: "5px", bw: "1px", font: "sans-inter", size: "13px" },
    dark: { bg: "#150f1c", card: "#1d1626", fg: "#ece2f6", muted: "#9b8bad",
            edge: "#2e2340", rule: "#221a2e", rail: "#8a5cd6", focus: "#e07bd0",
            no: "#e4707f" },
    light: { bg: "#f4eefb", card: "#fdfaff", fg: "#2f2438", muted: "#7d6e8c",
             edge: "#e0d3ee", rule: "#ebe2f5", rail: "#7a4fc0", focus: "#a8459a",
             no: "#b6455a" } },

  { name: "sand", shape: { r: "2px", gap: "4px", bw: "1px", font: "mono-sf", size: "13px" },
    dark: { bg: "#191712", card: "#221f19", fg: "#efe9dd", muted: "#9d9384",
            edge: "#342f25", rule: "#26221c", rail: "#8a7752", focus: "#d7b46a",
            no: "#cf6f62" },
    light: { bg: "#f2ede4", card: "#fbf8f2", fg: "#3a352c", muted: "#8a8172",
             edge: "#e0d8c8", rule: "#eae3d7", rail: "#a8926b", focus: "#7a5c2e",
             no: "#a8443c" } },

  /* 통로 0. */
  { name: "paper", shape: { r: "0px", gap: "0px", bw: "1px", font: "sans-system", size: "13px" },
    dark: { bg: "#0d0d0e", card: "#151517", fg: "#e9e9ea", muted: "#8f8f93",
            edge: "#26262a", rule: "#26262a", rail: "#6a6a70", focus: "#e0e0e2",
            no: "#c96a6a" },
    light: { bg: "#ffffff", card: "#fbfbfb", fg: "#1a1a1c", muted: "#6e6e73",
             edge: "#e2e2e5", rule: "#e2e2e5", rail: "#a0a0a6", focus: "#1a1a1c",
             no: "#b53a3a" } },
];

export const MODES = ["dark", "light"];

/**
 * 현재 설정. 객체 하나이며 그대로 JSON 저장 형식이다.
 *
 * 값마다 변수를 두면 저장할 목록을 따로 관리해야 하고 값을 추가할 때마다 그 목록을
 * 수정해야 한다.
 */
export const defaults = {
  projectOpening: "windows",
  theme: THEMES[0].name,
  mode: "dark",
  /* 애플리케이션 메뉴의 언어. auto = 시스템 언어(지원하지 않으면 en). */
  language: "auto",

  /* 성능 트레이스(V5-104). 켜면 모든 계층이 <config-dir>/logs/performance.ndjson 에
     성능 줄을 기록하고 꺼지면 어떤 파일 작업도 하지 않는다. 진단 빌드 전용이 아니라
     모든 빌드에 상시 있는 장치다(docs/spec/settings.md). */
  "diagnostics.performance": false,

  /* 프로젝트 탭의 위치. top = 크롬 행, left = 왼쪽 세로 목록. */
  projectTabs: "top",
  /* 좌·우 영역의 표시 여부. 무엇을 표시할지는 links 가 정한다. */
  left: true,
  right: true,
  /* 포커스를 잃은 표면의 흐림 처리 여부. */
  dim: false,
  /* 포커스 카드의 표시 방식. border = 테두리, corner = 네 모서리 표식. */
  focusInd: "border",
  /* 카드가 가로지르는 구간의 경계선을 어디에 그리는지.
     over = 표면 위, under = 카드 아래, none = 그리지 않음. */
  fullRule: "under",
  /* 아래 넷은 테마가 기본값을 정하고 그 다음부터는 사용자가 지정한 값을 사용한다.
     테마를 다시 고르면 그 테마의 값으로 돌아간다. */
  /* 통로의 절반 폭(px). 0 이면 카드가 선 하나를 공유한다. */
  gap: parseFloat(THEMES[0].shape.gap),
  /* 카드의 모서리 반경(px). --r-sm 과 --r-xs 가 여기서 나온다. */
  radius: parseFloat(THEMES[0].shape.r),
  /* 폰트. FONTS 의 id 다. */
  font: THEMES[0].shape.font,
  /* 글자 크기(px). */
  size: parseFloat(THEMES[0].shape.size),
  /* 프레임 크롬과 모든 카드에 적용하는 글자 크기 배율. TEXT_STEPS 의 값이다(docs/spec/text-size.md). */
  textSize: 1,

  /* 사이드바는 세트를 조합해서 만든다. 세트 하나가 섹션을 순서대로 담고 links 가
     그 세트를 자리에 연결한다. 연결은 제목이 아니라 id 로 한다. 기본값은
     environment.json 의 sidebars 가 정한다(setSidebarDefaults). */
  sets: [],
  links: [],

  /* 배치 값(pt). 카드 사이드바의 최소·최대 폭과 새 사이드바의 초기 폭이다(docs/spec/settings.md). */
  sidebarMinWidth: 120,
  sidebarMaxWidth: 480,
  sidebarWidth: 190,
};

/* 배치 값의 범위. 정수만 받는다. 세 값이 한 범위를 함께 써서 같은 값이 같은 슬라이더 위치에 놓인다. */
const WIDTH_RANGE = [60, 800];
export const LAYOUT_RANGES = {
  sidebarMinWidth: WIDTH_RANGE,
  sidebarMaxWidth: WIDTH_RANGE,
  sidebarWidth: WIDTH_RANGE,
};

/* 애플리케이션 메뉴가 지원하는 언어. 새 언어는 이 선언과 호스트 계약의 메뉴 표에 함께 추가된다. */
export const MENU_LANGUAGES = [
  { id: "ko", label: "한국어" },
  { id: "en", label: "English" },
];
/* 시스템 언어가 표에 없을 때 쓰는 기본 언어. */
const DEFAULT_LANGUAGE = "en";

/* 형태 값의 범위(px). 정수만 받고 설정 창의 슬라이더도 이 범위를 쓴다. */
export const SHAPE_RANGES = {
  gap: [0, 24],
  radius: [0, 24],
  size: [10, 18],
};

/* 선택지 하나를 받는 core 설정. 설정 창의 선택 컨트롤은 이 순서로 선택지를 보인다(docs/spec/settings.md#values). */
export const CHOICES = {
  projectOpening: ["tabs", "windows"],
  theme: THEMES.map((theme) => theme.name),
  mode: MODES,
  font: FONTS.map((font) => font.id),
  textSize: TEXT_STEPS,
  projectTabs: ["top", "left"],
  focusInd: ["border", "corner"],
  fullRule: ["under", "over", "none"],
  language: ["auto", ...MENU_LANGUAGES.map((language) => language.id)],
};

/* 정수 범위를 받는 core 설정. 배치 값과 형태 값은 키가 겹치지 않는다. */
const RANGES = { ...LAYOUT_RANGES, ...SHAPE_RANGES };

/* boolean 을 받는 core 설정. */
const SWITCHES = ["left", "right", "dim", "diagnostics.performance"];

/** 유효 설정을 검사한다. 사이드바 세트와 연결, 그리고 카드 안 사이드바의 처음 폭이 최소와 최대 사이에 있는지. */
function checkValues(values) {
  checkSidebars(values);
  if (!(values.sidebarMinWidth <= values.sidebarWidth && values.sidebarWidth <= values.sidebarMaxWidth)) {
    throw new Error("Invalid setting: sidebarMinWidth <= sidebarWidth <= sidebarMaxWidth does not hold");
  }
}

let settings = structuredClone(defaults);
const pluginDefinitions = new Map();
/* 환경의 manifest. 저장된 세트의 섹션과 연결의 플러그인을 이 목록으로 검사한다. */
let manifestList = [];

/** 유효 설정의 sets 와 links 를 environment.json 의 sidebars 와 같은 함수로 검사한다. */
function checkSidebars(values) {
  const sidebars = { sets: values.sets, links: values.links };
  validateSidebars(sidebars, "settings");
  checkSidebarReferences(sidebars, manifestList, "settings");
}

let common = {};
let overrides = {};
let projectId = null;
let store;
let writing = Promise.resolve();
let changes = 0;
let revision = 0;

/** 값 하나를 그 설정의 선언된 형식으로 검사한다. sets 와 links 는 checkSidebars 가 유효 설정 전체로 검사한다. */
function validateValue(key, value) {
  const choices = CHOICES[key];
  if (choices && !choices.includes(value)) {
    throw new Error(`Invalid setting ${key}: ${JSON.stringify(value)} is not one of ${choices.map((choice) => JSON.stringify(choice)).join(", ")}`);
  }
  if (SWITCHES.includes(key) && typeof value !== "boolean") {
    throw new Error(`Invalid setting ${key}: ${JSON.stringify(value)} is not a boolean`);
  }
  const range = RANGES[key];
  if (range && (!Number.isInteger(value) || value < range[0] || value > range[1])) {
    throw new Error(`Invalid setting ${key}: ${JSON.stringify(value)} is not an integer from ${range[0]} to ${range[1]}`);
  }
  const definition = pluginDefinitions.get(key);
  if (!definition) return;
  if (definition.type === "enum" && !definition.values.includes(value)) {
    throw new Error(`Invalid setting ${key}: value is not declared`);
  }
  if (definition.type === "integer" &&
      (!Number.isInteger(value) || value < definition.minimum || value > definition.maximum)) {
    throw new Error(`Invalid setting ${key}: integer value is outside its declared range`);
  }
  if (definition.type === "string" &&
      (typeof value !== "string" || value.length === 0 || value.length > definition.maxLength)) {
    throw new Error(`Invalid setting ${key}: string value must be non-empty and at most ${definition.maxLength} characters`);
  }
  if (definition.type === "address" && !isSettingAddress(value)) {
    throw new Error(`Invalid setting ${key}: address value must be empty or an http or https address`);
  }
}

/**
 * 불러오지 않은 플러그인의 저장된 설정인가. 그런 key 는 첫 `.` 앞이 불러온 플러그인이 아닌 플러그인 id 이며,
 * 파일에 그대로 두고 검사하지도 적용하지도 않는다(docs/spec/plugins.md).
 */
function keptSetting(key) {
  const dot = key.indexOf(".");
  return !Object.hasOwn(defaults, key) && dot > 0 && !manifestList.some((manifest) => manifest.id === key.slice(0, dot));
}

/** 적용할 설정만 남긴다. 불러오지 않은 플러그인의 설정은 저장소에만 있다. */
function applied(values) {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !keptSetting(key)));
}

/**
 * 프로젝트 설정이 덮어쓸 수 없는 공통 전용 키(docs/spec/projects.md#persistence). 호스트는 페이지 시작 전에 공통 설정의
 * textSize 로 창 제목줄을 정하므로 프레임 배율은 공통 전용이다(docs/spec/native-surfaces.md#title-bar-height).
 */
const COMMON_ONLY = Object.freeze(["projectOpening", "textSize"]);

/** 프로젝트 설정에 공통 전용 키가 있으면 오류다. */
function checkCommonOnly(values) {
  for (const key of COMMON_ONLY) {
    if (Object.hasOwn(values, key)) throw new Error(`project settings: ${key} is common-only`);
  }
}

function validateValues(values, where) {
  if (!values || typeof values !== "object") throw new Error(`${where} are not an object`);
  for (const [key, value] of Object.entries(values)) {
    if (keptSetting(key)) continue;
    if (!Object.hasOwn(defaults, key)) throw new Error(`${where}: unknown setting ${key}`);
    validateValue(key, value);
  }
}

/** 영속 설정을 불러오기 전에 검증된 플러그인 설정을 등록한다. */
export function setPluginSettings(manifests, applicationValues = {}) {
  if (store) throw new Error("plugin settings must be set before settings are connected");
  manifestList = manifests;
  for (const manifest of manifests) {
    // 기본값: settings 는 plugin.json 의 선택 필드이며 없으면 플러그인 설정이 없다(docs/spec/plugins.md).
    for (const [local, definition] of Object.entries(manifest.settings ?? {})) {
      const key = `${manifest.id}.${local}`;
      if (pluginDefinitions.has(key) || Object.hasOwn(defaults, key)) {
        throw new Error(`duplicate setting: ${key}`);
      }
      pluginDefinitions.set(key, Object.freeze({ ...definition, plugin: manifest.id, local }));
      defaults[key] = definition.default;
      // 기본값: environment.json 이 초기 값을 주지 않은 플러그인은 초기 값이 없다.
      if (Object.hasOwn(applicationValues[manifest.id] ?? {}, local)) {
        validateValue(key, applicationValues[manifest.id][local]);
        defaults[key] = applicationValues[manifest.id][local];
      }
    }
  }
  settings = structuredClone(defaults);
}

export const settingDefinitions = () => Object.fromEntries(
  [...pluginDefinitions.entries()].map(([key, definition]) => [key, structuredClone(definition)]),
);

export function pluginSettings(pluginId) {
  const values = {};
  for (const [key, definition] of pluginDefinitions) {
    if (definition.plugin === pluginId) values[definition.local] = settings[key];
  }
  return values;
}

/** environment.json 의 사이드바 기본값을 등록한다. 설정 저장소를 연결하기 전에 호출한다. */
export function setSidebarDefaults(sidebars) {
  if (store) throw new Error("sidebar defaults must be set before settings are connected");
  defaults.sets = structuredClone(sidebars.sets);
  defaults.links = structuredClone(sidebars.links);
  settings = structuredClone(defaults);
}

/** 공통 설정과 각 프로젝트 설정을 현재 형식으로 한 번 바꿔 저장하고 그 결과를 보고한다(docs/spec/settings.md). */
async function migrateStoredSettings() {
  const snapshot = await store.snapshot();
  const scopes = [[null, "the common settings", snapshot.common],
    // 기본값: 설정을 덮어쓰지 않은 프로젝트에는 settings 가 없다.
    ...snapshot.projects.map((project) => [project.id, `the project ${project.id} settings`, project.settings ?? {}])];
  for (const [id, where, values] of scopes) {
    const { patch, notes } = migrateSettings(values, knownSets(values, id === null ? null : snapshot.common));
    if (!notes.length) continue;
    await store.settings(id, patch);
    log(`settings: converted ${where}: ${notes.join("; ")}`);
  }
}

/**
 * values 의 연결이 가리킬 수 있는 세트 id. 세트는 그 범위에 저장된 것이고, 없으면 공통 설정(common 이 주어지면)의
 * 것이며, 그것도 없으면 환경의 기본 세트다.
 */
function knownSets(values, common) {
  // 기본값: 세트를 저장하지 않은 범위는 아래 범위의 세트를 쓴다.
  const sets = values.sets ?? common?.sets ?? defaults.sets;
  return new Set(sets.map((set) => set.id));
}

/** 저장된 값을 현재 형식으로 바꾼 값. 바꾼 값의 저장과 보고는 migrateStoredSettings 가 한다. */
function migrated(values, common) {
  const next = { ...values };
  for (const [key, value] of Object.entries(migrateSettings(values, knownSets(values, common)).patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
}

/**
 * 시작 문서의 스냅샷으로 첫 화면의 설정을 적용한다(docs/spec/native-host.md#page-start). id 는 창이 여는 프로젝트이고
 * 라이브러리면 null 이다. 저장소 연결과 이후의 변경은 connectSettings 가 맡는다.
 */
export function beginSettings(snapshot, id) {
  const nextCommon = migrated(snapshot.common, null);
  // 기본값: 설정을 덮어쓰지 않은 프로젝트에는 settings 가 없다.
  const nextOverrides = migrated(snapshot.projects.find((p) => p.id === id)?.settings ?? {}, nextCommon);
  validateValues(nextCommon, "common settings");
  validateValues(nextOverrides, "project settings");
  checkCommonOnly(nextOverrides);
  checkValues(effectiveSettings(defaults, applied(nextCommon), applied(nextOverrides)));
  projectId = id;
  common = nextCommon;
  overrides = nextOverrides;
  apply();
}

export async function connectSettings(storage) {
  store = storage;
  await migrateStoredSettings();
  store.onChange(() => { if (!changes) return refresh().catch((e) => dispatchEvent(new ErrorEvent("error", { message: e.message }))); });
  await refresh();
}

async function refresh() {
  const mine = ++revision;
  const snapshot = await store.snapshot();
  if (changes || mine !== revision) return;
  // 기본값: 설정을 덮어쓰지 않은 프로젝트에는 settings 가 없다.
  const nextOverrides = snapshot.projects.find((p) => p.id === projectId)?.settings ?? {};
  validateValues(snapshot.common, "common settings");
  validateValues(nextOverrides, "project settings");
  checkCommonOnly(nextOverrides);
  checkValues(effectiveSettings(defaults, applied(snapshot.common), applied(nextOverrides)));
  if (JSON.stringify(common) !== JSON.stringify(snapshot.common) || JSON.stringify(overrides) !== JSON.stringify(nextOverrides)) {
    common = snapshot.common;
    overrides = nextOverrides;
    apply();
  }
  await setTraceEnabled(settings["diagnostics.performance"]);
}

function apply() {
  settings = effectiveSettings(defaults, applied(common), applied(overrides));
  install();
  announce();
}

export async function selectProject(id) {
  await writing;
  projectId = id;
  await refresh();
}

export const settingProject = () => projectId;
export const scopedValue = (key, scope) => scope === "common"
  // 기본값: 저장된 공통 값이 없는 설정은 기본값이다.
  ? (common[key] ?? defaults[key]) : settings[key];
export const overridden = (key) => Object.hasOwn(overrides, key);
export const flushSettings = () => writing;
export const reset = (key) => set({ [key]: undefined }, "project");

/** 이름으로 테마를 반환한다. 목록에 없는 이름이면 예외를 던진다. */
function themeOf(name) {
  const found = THEMES.find((t) => t.name === name);
  if (!found) throw new Error(`unknown theme: ${name}`);
  return found;
}

/** 현재 토큰 값. 표면과 모달이 같은 값을 받는다. */
function themeTokens() {
  const theme = themeOf(settings.theme);
  const c = theme[settings.mode];
  return {
    "--bg": c.bg, "--card": c.card, "--fg": c.fg, "--muted": c.muted,
    "--edge": c.edge, "--rule": c.rule, "--rail": c.rail, "--focus": c.focus,
    "--no": c.no,
    // 형태 넷은 테마가 아니라 설정이 보관한다. 테마는 선택 시 한 번 값을
    // 설정한다(applyTheme). 여기서 테마 값을 쓰면 사용자가 바꾼 값이 지워진다.
    "--r": `${settings.radius}px`, "--half-gap": `${halfGap()}px`,
    "--bw": theme.shape.bw,
    "--font": fontOf(settings.font).stack, "--size": `${settings.size}px`,
  };
}

/** id 로 폰트를 반환한다. 목록에 없는 id 이면 예외를 던진다. */
function fontOf(id) {
  const found = FONTS.find((f) => f.id === id);
  if (!found) throw new Error(`unknown font: ${id}`);
  return found;
}

/**
 * 이음새. 통로가 0 이면 카드가 선 하나를 공유하고, 아니면 통로가 카드를 떼어 놓는다.
 *
 * 별도의 설정값을 두지 않는다. 두 값을 두면 통로 0 이면서 이음새가 gap 인 상태가
 * 생기고, 그 상태에는 그릴 것이 없다.
 */
const seam = () => (settings.gap === 0 ? "line" : "gap");

/* 애플리케이션이 서비스하는 페이지는 별도 문서라 이 문서의 스타일시트를 상속하지
   않는다. 토큰 값을 전송하면 그쪽에서 자기 루트에 설정한다. */
const pageTheme = () => ({ scheme: settings.mode, tokens: themeTokens() });

/**
 * 테마와 모드를 적용한다.
 *
 * 값을 루트에 설정한다. 스타일시트를 교체하지 않으므로 사용자가 색 입력으로 지정한
 * 값이 유지된다.
 */
export function applyTheme(name, next, scope) {
  if (!MODES.includes(next)) throw new Error(`unknown mode: ${next}`);
  const theme = themeOf(name);
  // 테마 선택이 형태 네 값도 함께 설정한다.
  return set({
    theme: theme.name, mode: next,
    gap: parseFloat(theme.shape.gap), radius: parseFloat(theme.shape.r),
    font: theme.shape.font, size: parseFloat(theme.shape.size),
  }, scope);
}

/** 설정값 하나를 반환한다. */
export const value = (key) => settings[key];

/**
 * 설정의 일부를 변경하고, 값을 적용한 뒤 변경을 통지한다.
 *
 * 변경 경로는 이 함수 하나다. 값마다 함수를 두면 적용을 누락한 함수가 생긴다.
 */
export function set(patch, scope = projectId ? "project" : "common") {
  const id = scope === "project" ? projectId : null;
  if (scope === "project" && !id) throw new Error("No project is selected");
  if (id && Object.hasOwn(patch, "projectOpening")) throw new Error("Project opening mode is common-only");
  if (id && Object.hasOwn(patch, "textSize")) throw new Error("Text size is common-only");
  for (const [key, val] of Object.entries(patch)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown setting: ${key}`);
    if (val !== undefined) validateValue(key, val);
  }
  const target = id ? overrides : common;
  const patched = { ...target };
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) delete patched[key];
    else patched[key] = val;
  }
  checkValues(id ? effectiveSettings(defaults, applied(common), applied(patched)) : effectiveSettings(defaults, applied(patched), applied(overrides)));
  for (const [key, val] of Object.entries(patch)) {
    if (val === undefined) delete target[key];
    else target[key] = val;
  }
  changes++;
  revision++;
  apply();
  const propagation = Object.hasOwn(patch, "diagnostics.performance")
    ? setTraceEnabled(settings["diagnostics.performance"]) : Promise.resolve();
  const saved = Promise.all([writing, propagation]).then(() => store.settings(id, patch));
  writing = saved.finally(async () => {
    changes--;
    if (changes) return;
    await refresh();
    savedListener();
  });
  return writing;
}

let savedListener = () => {};

/** 저장 중인 설정 변경이 있는지 반환한다. */
export const saving = () => changes > 0;

/** 저장 중인 변경이 모두 저장되면 fn 을 호출한다. */
export function onSaved(fn) {
  savedListener = fn;
}

/** 값을 문서 루트에 설정한다. 시작 시 한 번, 이후 변경할 때마다 호출한다. */
export function install() {
  const root = document.documentElement;
  root.style.colorScheme = settings.mode;
  // 스타일시트가 모드에 따라 다른 색을 고를 때 읽는다(로고의 글자).
  root.dataset.mode = settings.mode;
  // 스타일시트가 읽는 두 값. 표시만 바뀌므로 판을 다시 만들지 않는다.
  root.dataset.focusInd = settings.focusInd;
  root.dataset.fullRule = settings.fullRule;
  root.dataset.seam = seam();
  // 프레임 크롬의 CSS zoom 이 읽는 프레임 글자 배율은 여기서 쓰지 않는다. 준비한 배치의 그리기가 쓴다(frame-text.js).
  // 표면은 자기 실제 배율을 다시 읽는다.
  notifyTextSize();
  for (const [token, value] of Object.entries(themeTokens())) {
    root.style.setProperty(token, value);
  }
  // 호스트가 서비스하는 페이지는 이 문서의 스타일시트를 상속하지 않으므로 값을
  // 따로 전송한다.
  host.theme(pageTheme());
  // 애플리케이션 메뉴의 언어. 유효 언어가 바뀔 때만 호스트가 메뉴를 다시 만든다.
  host.menuLanguage(menuLanguage());
}

/** 애플리케이션 메뉴의 유효 언어. 설정이 auto 이면 시스템 언어의 주 태그를 표에서 찾고 없으면 기본 언어다. */
export function menuLanguage() {
  const chosen = settings.language;
  if (chosen !== "auto") return chosen;
  // 기본값: navigator.language 는 삽입 문맥 등에서 비울 수 있고 그때 계약의 기본 언어가 시스템 언어를 대신한다.
  const tag = (navigator.language ?? DEFAULT_LANGUAGE).split("-")[0].toLowerCase();
  return MENU_LANGUAGES.some((language) => language.id === tag) ? tag : DEFAULT_LANGUAGE;
}
/** 카드의 모서리 반경(px). 이음새가 line 이면 카드는 각지다. */
export const cardRadius = () => (seam() === "line" ? 0 : settings.radius);

/* 설정 변경 수신자. 판 하나가 연결된다. */
const listeners = new Set();

/** 설정이 바뀔 때 호출할 함수를 등록한다. */
export function onSettingsChange(fn) {
  if (typeof fn !== "function") throw new TypeError("settings listener must be a function");
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const announce = () => { for (const fn of listeners) fn(); };

/** 세트 전부를 반환한다. 사이드바 편집 시 선택 목록으로 사용한다. */
export const sets = () => settings.sets;

/**
 * 사이드바 선택 하나를 바꾼다. choice 는 세트 id, off, inherit 이다(docs/spec/settings.md 의 사이드바 선택).
 */
export function link(place, plugin, choice, scope) {
  return set({ links: chooseLink(scopedValue("links", scope), place, plugin, choice) }, scope);
}

/** 해당 위치에 보일 세트를 반환한다. left, right 는 plugin 의 선택이 일반 선택보다 앞선다. 없으면 null. */
export const linkedSet = (place, plugin) => resolveSidebar(settings.links, settings.sets, place, plugin);

/** 현재 테마 이름과 모드를 반환한다. */
export const themeName = () => settings.theme;
export const modeName = () => settings.mode;

/**
 * 통로의 절반 폭(px). 판이 gap 을 이 값의 두 배로 설정한다.
 *
 * 설정이 0 이면 선 굵기의 절반을 반환한다. 통로가 0 이면 카드의 rect 가 맞닿아
 * 경계선을 그릴 자리가 없고, 네이티브 표면 둘도 맞닿아 선이 표면 뒤로 들어간다.
 * 선 하나만큼 벌리면 그 자리가 곧 두 카드의 공유 보더다.
 */
export function halfGap() {
  if (settings.gap > 0) return settings.gap;
  return parseFloat(themeOf(settings.theme).shape.bw) / 2;
}

/** 현재 테마의 선 굵기(px). 카드 보더와 레일이 이 굵기로 그려진다. */
export const borderWidth = () => parseFloat(themeOf(settings.theme).shape.bw);

/**
 * 판이 stage 안으로 들어와 있는 거리(px). 뷰의 bleed 가 이 값이다.
 *
 * stage 의 안쪽 여백이고, 선이 그만큼 판 밖으로 나가 stage 의 테두리에 닿는다.
 * 통로의 절반이 아니다: 이음새에서는 스타일시트가 그 여백을 0 으로 만드는데 절반은
 * 선 굵기의 절반이므로, 절반을 주면 선이 여백 없는 판 밖으로 나가 테두리 위에
 * 그려진다.
 */
export const stagePad = () => (seam() === "line" ? 0 : halfGap());

/** 설정에 들어 있는 통로 값(px). 슬라이더가 표시하는 값이다. */
export const gapSetting = () => settings.gap;
