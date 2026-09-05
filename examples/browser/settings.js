// 판 외부의 설정값. 테마, 모드, 형태.
//
// 값이 바뀌면 판의 배치도 바뀌지만 이 모듈은 판을 호출하지 않고 변경만 통지한다.
// 설정이 판을 참조하면 설정을 추가할 때마다 호출할 판의 함수를 정해야 한다.

/* ── 테마 ──────────────────────────────────────────────────────────────────
   축이 둘이다. 테마가 형태와 색을 정하고, 모드가 그 테마의 dark 와 light 중
   하나를 선택한다. 모든 테마는 양쪽 값을 모두 갖는다.

   형태(모서리 반경, 통로 폭, 보더 굵기)는 모드와 무관하다. 밝기가 바뀐다고
   모서리가 바뀔 이유는 없다.

   적용은 값을 루트에 심는 것이다. 표면과 모달은 각자 다른 문서라 이 문서의
   스타일시트를 물려받지 못하므로, 호스트가 이 값들을 그대로 실어 보낸다.     */
export const THEMES = [
  { name: "midnight", shape: { r: "14px", gap: "12px", bw: "1px" },
    dark: { bg: "#101117", card: "#1b1d27", fg: "#ececf5", muted: "#9b9dad",
            bd: "#7279ff", rail: "#ffb36b", focus: "#ffb36b", ok: "#53dc93",
            no: "#ff7c7c", surface: "#0d1a14", surfaceFg: "#7fe3b0" },
    light: { bg: "#eef0f7", card: "#ffffff", fg: "#252735", muted: "#6c6f7e",
             bd: "#5962e8", rail: "#c06a1f", focus: "#c06a1f", ok: "#12894f",
             no: "#c62c2c", surface: "#e8f5ee", surfaceFg: "#12684a" } },

  { name: "nord", shape: { r: "8px", gap: "8px", bw: "1px" },
    dark: { bg: "#2e3440", card: "#3b4252", fg: "#eceff4", muted: "#8b93a5",
            bd: "#81a1c1", rail: "#ebcb8b", focus: "#88c0d0", ok: "#a3be8c",
            no: "#bf616a", surface: "#242933", surfaceFg: "#8fbcbb" },
    light: { bg: "#eceff4", card: "#ffffff", fg: "#2e3440", muted: "#6d7789",
             bd: "#5e81ac", rail: "#b48a2f", focus: "#4c7899", ok: "#57734a",
             no: "#a3454e", surface: "#e0e6ef", surfaceFg: "#3b6a63" } },

  { name: "solar", shape: { r: "6px", gap: "14px", bw: "2px" },
    dark: { bg: "#002b36", card: "#073642", fg: "#eee8d5", muted: "#93a1a1",
            bd: "#b58900", rail: "#cb4b16", focus: "#268bd2", ok: "#859900",
            no: "#dc322f", surface: "#012b33", surfaceFg: "#93a1a1" },
    light: { bg: "#fdf6e3", card: "#fffdf6", fg: "#3b4a4f", muted: "#8a9599",
             bd: "#b58900", rail: "#cb4b16", focus: "#268bd2", ok: "#859900",
             no: "#dc322f", surface: "#f4ecd8", surfaceFg: "#586e75" } },

  { name: "forest", shape: { r: "18px", gap: "12px", bw: "1px" },
    dark: { bg: "#0e1512", card: "#16211c", fg: "#dfeee6", muted: "#7d9389",
            bd: "#3f8f6b", rail: "#d9a441", focus: "#5fd7a0", ok: "#5fd7a0",
            no: "#e0736d", surface: "#0a1410", surfaceFg: "#86e0b4" },
    light: { bg: "#eef4f0", card: "#ffffff", fg: "#1f3129", muted: "#6b8378",
             bd: "#2f7a58", rail: "#a8761f", focus: "#1f7a55", ok: "#2f8f5f",
             no: "#b1453f", surface: "#e2eee7", surfaceFg: "#1f6a4a" } },

  { name: "ember", shape: { r: "4px", gap: "6px", bw: "2px" },
    dark: { bg: "#17100e", card: "#241916", fg: "#f3e4de", muted: "#a1877e",
            bd: "#c4603a", rail: "#e8a33d", focus: "#ff9a5a", ok: "#9ac06a",
            no: "#e05252", surface: "#1c1210", surfaceFg: "#ffb98a" },
    light: { bg: "#faf0ea", card: "#fffaf6", fg: "#3a2822", muted: "#8d7268",
             bd: "#b1552f", rail: "#a56a17", focus: "#c25a22", ok: "#5f7f43",
             no: "#b23a3a", surface: "#f3e4da", surfaceFg: "#8a4a24" } },

  { name: "slate", shape: { r: "10px", gap: "16px", bw: "1px" },
    dark: { bg: "#15171a", card: "#1e2126", fg: "#e6e9ee", muted: "#8d939d",
            bd: "#4a5058", rail: "#9aa3ae", focus: "#c7ced8", ok: "#6fbf8b",
            no: "#d97070", surface: "#101215", surfaceFg: "#b9c1cc" },
    light: { bg: "#f1f3f5", card: "#ffffff", fg: "#23282e", muted: "#6f7781",
             bd: "#aeb6c0", rail: "#5f6a76", focus: "#3d4854", ok: "#2f8f5f",
             no: "#b1453f", surface: "#e6e9ed", surfaceFg: "#3d4854" } },

  { name: "mist", shape: { r: "16px", gap: "12px", bw: "1px" },
    dark: { bg: "#121821", card: "#1a222d", fg: "#e2eaf2", muted: "#7f8fa1",
            bd: "#4c6c88", rail: "#7fa9cc", focus: "#8ec5ea", ok: "#5fc39a",
            no: "#dd7a74", surface: "#0e141b", surfaceFg: "#9ec6e0" },
    light: { bg: "#eef2f5", card: "#f9fbfc", fg: "#2b3440", muted: "#71808f",
             bd: "#9db4c8", rail: "#4d7ea8", focus: "#2f6f9f", ok: "#2f8f6a",
             no: "#b8453f", surface: "#e3ebf1", surfaceFg: "#2f5d78" } },

  { name: "grape", shape: { r: "20px", gap: "10px", bw: "1px" },
    dark: { bg: "#150f1c", card: "#211829", fg: "#ece2f6", muted: "#9b8bad",
            bd: "#8a5cd6", rail: "#e07bd0", focus: "#c39bff", ok: "#6fd3a8",
            no: "#e4707f", surface: "#100b16", surfaceFg: "#cbb0f5" },
    light: { bg: "#f4eefb", card: "#fdfaff", fg: "#2f2438", muted: "#7d6e8c",
             bd: "#7a4fc0", rail: "#a8459a", focus: "#6b3fb0", ok: "#2f8f6a",
             no: "#b6455a", surface: "#eae0f5", surfaceFg: "#5a3a8a" } },

  { name: "sand", shape: { r: "2px", gap: "8px", bw: "2px" },
    dark: { bg: "#191712", card: "#23201a", fg: "#efe9dd", muted: "#9d9384",
            bd: "#8a7752", rail: "#c88a4a", focus: "#d7b46a", ok: "#8fae63",
            no: "#cf6f62", surface: "#141210", surfaceFg: "#d8c9a8" },
    light: { bg: "#f2ede4", card: "#fbf8f2", fg: "#3a352c", muted: "#8a8172",
             bd: "#a8926b", rail: "#a35b2a", focus: "#7a5c2e", ok: "#5f7f43",
             no: "#a8443c", surface: "#e9e2d4", surfaceFg: "#5c5140" } },

  { name: "paper", shape: { r: "12px", gap: "10px", bw: "1px" },
    dark: { bg: "#0d0d0e", card: "#171719", fg: "#e9e9ea", muted: "#8f8f93",
            bd: "#565659", rail: "#c9a227", focus: "#e0e0e2", ok: "#6aa87a",
            no: "#c96a6a", surface: "#0a0a0b", surfaceFg: "#c7c7ca" },
    light: { bg: "#ffffff", card: "#fbfbfb", fg: "#1a1a1c", muted: "#6e6e73",
             bd: "#c9c9cd", rail: "#8a6d1f", focus: "#1a1a1c", ok: "#2f7d4f",
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
  /* 카드 사이 경계선의 표시 여부. */
  fullRule: "hide",
  /* 통로의 절반 폭(px). 테마를 선택하면 그 테마의 값으로 설정되고, 이후에는
     사용자가 지정한 값을 사용한다. */
  gap: parseFloat(THEMES[0].shape.gap),

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
    "--bd": c.bd, "--rail": c.rail, "--focus": c.focus, "--ok": c.ok,
    "--no": c.no, "--surface": c.surface, "--surface-fg": c.surfaceFg,
    // 통로는 테마가 아니라 설정이 보관한다. 테마는 선택 시 한 번 값을
    // 설정한다(applyTheme). 여기서 테마 값을 쓰면 사용자가 바꾼 값이 지워진다.
    "--r": theme.shape.r, "--half-gap": `${settings.gap}px`, "--bw": theme.shape.bw,
  };
}

/* 호스트가 서비스하는 페이지는 별도 문서라 이 문서의 스타일시트를 상속하지 않는다.
   토큰 값을 전송하면 그쪽에서 자기 루트에 설정한다. */
window.pageTheme = () => ({ scheme: settings.mode, tokens: themeTokens() });

/**
 * 테마와 모드를 적용한다.
 *
 * 값을 루트에 설정한다. 스타일시트를 교체하지 않으므로 사용자가 색 입력으로 지정한
 * 값이 유지된다.
 */
export function applyTheme(name, next) {
  if (!MODES.includes(next)) throw new Error(`unknown mode: ${next}`);
  const theme = themeOf(name);
  // 테마 선택이 통로 값도 함께 설정한다.
  set({ theme: theme.name, mode: next, gap: parseFloat(theme.shape.gap) });
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
  for (const [token, value] of Object.entries(themeTokens())) {
    root.style.setProperty(token, value);
  }
  // 호스트가 서비스하는 페이지는 이 문서의 스타일시트를 상속하지 않으므로 값을
  // 따로 전송한다.
  window.hostSurfaces?.theme?.(window.pageTheme());
}
/** 카드의 모서리 반경을 반환한다. 테마가 결정하므로 상수로 둘 수 없다. */
export const cardRadius = () =>
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--r")) || 0;

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

/** 통로의 절반 폭(px). 판이 gap 과 bleed 를 이 값으로 설정한다. */
export const halfGap = () => settings.gap;

