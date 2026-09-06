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

/* 고를 수 있는 폰트. 테마가 이 중 하나를 기본으로 지정하고 설정에서 바꾼다.
   설치되지 않은 이름은 목록의 다음 이름으로 넘어간다. */
import { onTheme, surfaces as host } from "./host.js";

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
            no: "#ff7c7c", surface: "#0d1a14", surfaceFg: "#7fe3b0" },
    light: { bg: "#eef0f4", card: "#ffffff", fg: "#252735", muted: "#6c6f7e",
             edge: "#d8dbe4", rule: "#e3e6ec", rail: "#5962e8", focus: "#c06a1f",
             no: "#c62c2c", surface: "#e8f5ee", surfaceFg: "#12684a" } },

  { name: "nord", shape: { r: "8px", gap: "5px", bw: "1px", font: "mono-sf", size: "13px" },
    dark: { bg: "#2e3440", card: "#353c4a", fg: "#eceff4", muted: "#8b93a5",
            edge: "#454d5e", rule: "#3a4150", rail: "#81a1c1", focus: "#ebcb8b",
            no: "#bf616a", surface: "#242933", surfaceFg: "#8fbcbb" },
    light: { bg: "#eceff4", card: "#ffffff", fg: "#2e3440", muted: "#6d7789",
             edge: "#d8dee9", rule: "#e3e8ef", rail: "#5e81ac", focus: "#b48a2f",
             no: "#a3454e", surface: "#e0e6ef", surfaceFg: "#3b6a63" } },

  { name: "solar", shape: { r: "6px", gap: "7px", bw: "2px", font: "mono-system", size: "13px" },
    dark: { bg: "#002b36", card: "#05323d", fg: "#eee8d5", muted: "#8b9ea0",
            edge: "#0f4451", rule: "#073642", rail: "#268bd2", focus: "#cb4b16",
            no: "#dc322f", surface: "#012b33", surfaceFg: "#93a1a1" },
    light: { bg: "#fdf6e3", card: "#fffdf6", fg: "#3b4a4f", muted: "#8a9599",
             edge: "#e8dfc4", rule: "#f0e7d0", rail: "#268bd2", focus: "#cb4b16",
             no: "#dc322f", surface: "#f4ecd8", surfaceFg: "#586e75" } },

  { name: "forest", shape: { r: "14px", gap: "6px", bw: "1px", font: "sans-system", size: "13px" },
    dark: { bg: "#0e1512", card: "#141d19", fg: "#dfeee6", muted: "#7d9389",
            edge: "#22302a", rule: "#1a241f", rail: "#3f8f6b", focus: "#d9a441",
            no: "#e0736d", surface: "#0a1410", surfaceFg: "#86e0b4" },
    light: { bg: "#eef4f0", card: "#ffffff", fg: "#1f3129", muted: "#6b8378",
             edge: "#d4e2da", rule: "#e2ebe6", rail: "#2f7a58", focus: "#a8761f",
             no: "#b1453f", surface: "#e2eee7", surfaceFg: "#1f6a4a" } },

  { name: "ember", shape: { r: "4px", gap: "4px", bw: "2px", font: "mono-jet", size: "13px" },
    dark: { bg: "#17100e", card: "#201714", fg: "#f3e4de", muted: "#a1877e",
            edge: "#33241f", rule: "#271c18", rail: "#c4603a", focus: "#e8a33d",
            no: "#e05252", surface: "#1c1210", surfaceFg: "#ffb98a" },
    light: { bg: "#faf0ea", card: "#fffaf6", fg: "#3a2822", muted: "#8d7268",
             edge: "#ecd9cd", rule: "#f3e6dd", rail: "#b1552f", focus: "#a56a17",
             no: "#b23a3a", surface: "#f3e4da", surfaceFg: "#8a4a24" } },

  /* 통로 0. 카드가 서로 붙고 경계선 하나를 공유한다. */
  { name: "slate", shape: { r: "0px", gap: "0px", bw: "1px", font: "sans-inter", size: "13px" },
    dark: { bg: "#15171a", card: "#1c1f23", fg: "#e6e9ee", muted: "#8d939d",
            edge: "#2c3036", rule: "#2c3036", rail: "#6b7480", focus: "#c7ced8",
            no: "#d97070", surface: "#101215", surfaceFg: "#b9c1cc" },
    light: { bg: "#f1f3f5", card: "#ffffff", fg: "#23282e", muted: "#6f7781",
             edge: "#dcdfe4", rule: "#dcdfe4", rail: "#7b8593", focus: "#3d4854",
             no: "#b1453f", surface: "#e6e9ed", surfaceFg: "#3d4854" } },

  { name: "mist", shape: { r: "12px", gap: "6px", bw: "1px", font: "mono-system", size: "13px" },
    dark: { bg: "#121821", card: "#18202a", fg: "#e2eaf2", muted: "#7f8fa1",
            edge: "#283344", rule: "#1d2531", rail: "#4c6c88", focus: "#8ec5ea",
            no: "#dd7a74", surface: "#0e141b", surfaceFg: "#9ec6e0" },
    light: { bg: "#eef2f5", card: "#f9fbfc", fg: "#2b3440", muted: "#71808f",
             edge: "#d5dee6", rule: "#e3eaf0", rail: "#6f92ad", focus: "#2f6f9f",
             no: "#b8453f", surface: "#e3ebf1", surfaceFg: "#2f5d78" } },

  { name: "grape", shape: { r: "16px", gap: "5px", bw: "1px", font: "sans-inter", size: "13px" },
    dark: { bg: "#150f1c", card: "#1d1626", fg: "#ece2f6", muted: "#9b8bad",
            edge: "#2e2340", rule: "#221a2e", rail: "#8a5cd6", focus: "#e07bd0",
            no: "#e4707f", surface: "#100b16", surfaceFg: "#cbb0f5" },
    light: { bg: "#f4eefb", card: "#fdfaff", fg: "#2f2438", muted: "#7d6e8c",
             edge: "#e0d3ee", rule: "#ebe2f5", rail: "#7a4fc0", focus: "#a8459a",
             no: "#b6455a", surface: "#eae0f5", surfaceFg: "#5a3a8a" } },

  { name: "sand", shape: { r: "2px", gap: "4px", bw: "1px", font: "mono-sf", size: "13px" },
    dark: { bg: "#191712", card: "#221f19", fg: "#efe9dd", muted: "#9d9384",
            edge: "#342f25", rule: "#26221c", rail: "#8a7752", focus: "#d7b46a",
            no: "#cf6f62", surface: "#141210", surfaceFg: "#d8c9a8" },
    light: { bg: "#f2ede4", card: "#fbf8f2", fg: "#3a352c", muted: "#8a8172",
             edge: "#e0d8c8", rule: "#eae3d7", rail: "#a8926b", focus: "#7a5c2e",
             no: "#a8443c", surface: "#e9e2d4", surfaceFg: "#5c5140" } },

  /* 통로 0. */
  { name: "paper", shape: { r: "0px", gap: "0px", bw: "1px", font: "sans-system", size: "13px" },
    dark: { bg: "#0d0d0e", card: "#151517", fg: "#e9e9ea", muted: "#8f8f93",
            edge: "#26262a", rule: "#26262a", rail: "#6a6a70", focus: "#e0e0e2",
            no: "#c96a6a", surface: "#0a0a0b", surfaceFg: "#c7c7ca" },
    light: { bg: "#ffffff", card: "#fbfbfb", fg: "#1a1a1c", muted: "#6e6e73",
             edge: "#e2e2e5", rule: "#e2e2e5", rail: "#a0a0a6", focus: "#1a1a1c",
             no: "#b53a3a", surface: "#f2f2f3", surfaceFg: "#3a3a3d" } },
];

export const MODES = ["dark", "light"];

/**
 * 현재 설정. 객체 하나이며 그대로 JSON 저장 형식이다.
 *
 * 값마다 변수를 두면 저장할 목록을 따로 관리해야 하고 값을 추가할 때마다 그 목록을
 * 수정해야 한다.
 */
const settings = {
  theme: THEMES[0].name,
  mode: "dark",

  /* 프로젝트 탭의 위치. top = 크롬 행, left = 왼쪽 세로 레일. */
  projectTabs: "top",
  /* 레일의 포커스 추적 방식. flow = 추적, pin = 고정, off = 표시하지 않음. */
  rail: "flow",
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

  /* 사이드바는 세트를 조합해서 만든다. 세트 하나가 섹션을 순서대로 담고 links 가
     그 세트를 자리에 연결한다. 연결은 제목이 아니라 id 로 한다. */
  sets: [
    { id: "set-install", title: "탐색기", sections: ["files.tree", "files.bookmarks"] },
    { id: "set-shell", title: "셸", sections: ["terminal.history", "terminal.cwd"] },
    { id: "set-process", title: "프로세스", sections: ["terminal.pty", "terminal.jobs"] },
    { id: "set-page", title: "페이지", sections: ["browser.dom", "browser.network"] },
    { id: "set-browser", title: "브라우저", sections: ["browser.tabs", "browser.history"] },
  ],

  /* 세트를 자리에 연결한다. `plugin` 이 null 인 자리는 포커스를 추적하지 않는다.
     목록에 없는 자리는 사이드바를 표시하지 않는다. */
  links: [
    { place: "left", plugin: null, set: "set-install" },
    { place: "rail", plugin: "terminal", set: "set-shell" },
    { place: "right", plugin: "terminal", set: "set-process" },
    { place: "right", plugin: "browser", set: "set-browser" },
  ],
};

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
    "--no": c.no, "--surface": c.surface, "--surface-fg": c.surfaceFg,
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
export const seam = () => (settings.gap === 0 ? "line" : "gap");

/* 애플리케이션이 서비스하는 페이지는 별도 문서라 이 문서의 스타일시트를 상속하지
   않는다. 토큰 값을 전송하면 그쪽에서 자기 루트에 설정한다. */
const pageTheme = () => ({ scheme: settings.mode, tokens: themeTokens() });

onTheme(pageTheme);

/**
 * 테마와 모드를 적용한다.
 *
 * 값을 루트에 설정한다. 스타일시트를 교체하지 않으므로 사용자가 색 입력으로 지정한
 * 값이 유지된다.
 */
export function applyTheme(name, next) {
  if (!MODES.includes(next)) throw new Error(`unknown mode: ${next}`);
  const theme = themeOf(name);
  // 테마 선택이 형태 네 값도 함께 설정한다.
  set({
    theme: theme.name, mode: next,
    gap: parseFloat(theme.shape.gap), radius: parseFloat(theme.shape.r),
    font: theme.shape.font, size: parseFloat(theme.shape.size),
  });
}

/** 설정값 하나를 반환한다. */
export const value = (key) => settings[key];

/**
 * 설정의 일부를 변경하고, 값을 적용한 뒤 변경을 통지한다.
 *
 * 변경 경로는 이 함수 하나다. 값마다 함수를 두면 적용을 누락한 함수가 생긴다.
 */
export function set(patch) {
  Object.assign(settings, patch);
  install();
  // 통로는 배치가 사용하는 값이므로 설정이 바뀌면 판도 바뀐다. 그 처리는 수신자가
  // 하고 여기서는 변경만 통지한다.
  announce();
}

/** 값을 문서 루트에 설정한다. 시작 시 한 번, 이후 변경할 때마다 호출한다. */
export function install() {
  const root = document.documentElement;
  root.style.colorScheme = settings.mode;
  // 스타일시트가 읽는 두 값. 표시만 바뀌므로 판을 다시 만들지 않는다.
  root.dataset.focusInd = settings.focusInd;
  root.dataset.fullRule = settings.fullRule;
  root.dataset.seam = seam();
  for (const [token, value] of Object.entries(themeTokens())) {
    root.style.setProperty(token, value);
  }
  // 호스트가 서비스하는 페이지는 이 문서의 스타일시트를 상속하지 않으므로 값을
  // 따로 전송한다.
  host.theme(pageTheme());
}
/** 카드의 모서리 반경(px). 이음새가 line 이면 카드는 각지다. */
export const cardRadius = () => (seam() === "line" ? 0 : settings.radius);

/* 설정 변경 수신자. 판 하나가 연결된다. */
let listener = null;

/** 설정이 바뀔 때 호출할 함수를 등록한다. */
export function onSettingsChange(fn) {
  listener = fn;
}

const announce = () => listener?.();

/** 세트 전부를 반환한다. 사이드바 편집 시 선택 목록으로 사용한다. */
export const sets = () => settings.sets;

/**
 * 세트를 자리에 연결한다. `setId` 가 null 이면 연결을 제거하고 사이드바를 표시하지
 * 않는다.
 */
export function link(place, plugin, setId) {
  const rest = settings.links.filter((l) => !(l.place === place && l.plugin === plugin));
  set({ links: setId === null ? rest : [...rest, { place, plugin, set: setId }] });
}

/** 해당 자리에 연결된 세트의 id 를 반환한다. 없으면 null. */
export function linkedId(place, plugin) {
  const found = settings.links.find((l) => l.place === place && l.plugin === plugin);
  return found ? found.set : null;
}

/**
 * 해당 자리에 연결된 세트를 반환한다. 없으면 null.
 *
 * 섹션의 이름은 읽지 않는다. 등록 목록은 레지스트리가 갖고 설정은 선택한 id 만 갖는다.
 */
export function linkedSet(place, plugin) {
  const link = settings.links.find((l) => l.place === place && l.plugin === plugin);
  if (!link) return null;
  const set = settings.sets.find((s) => s.id === link.set);
  if (!set) throw new Error(`link points at a set that is gone: ${link.set}`);
  return set;
}

/** 현재 테마 이름과 모드를 반환한다. */
export const themeName = () => settings.theme;
export const modeName = () => settings.mode;

/**
 * 통로의 절반 폭(px). 판이 gap 과 bleed 를 이 값으로 설정한다.
 *
 * 설정이 0 이면 선 굵기의 절반을 반환한다. 통로가 0 이면 카드의 rect 가 맞닿아
 * 경계선을 그릴 자리가 없고, 네이티브 표면 둘도 맞닿아 선이 표면 뒤로 들어간다.
 * 선 하나만큼 벌리면 그 자리가 곧 두 카드의 공유 보더다.
 */
export function halfGap() {
  if (settings.gap > 0) return settings.gap;
  return parseFloat(themeOf(settings.theme).shape.bw) / 2;
}

/** 설정에 들어 있는 통로 값(px). 슬라이더가 표시하는 값이다. */
export const gapSetting = () => settings.gap;

