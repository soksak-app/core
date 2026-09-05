// 판 바깥의 값들 — 테마와 모드, 그리고 형태.
//
// 여기서 값이 바뀌면 판의 배치가 바뀐다. 그래도 이 모듈은 판을 부르지 않고
// 알리기만 한다: 설정이 판을 아는 순간 둘은 한 덩어리가 되고, 설정을 하나 더
// 넣을 때마다 판의 어느 함수를 불러야 하는지 매번 정해야 한다.

/* ── 테마 ──────────────────────────────────────────────────────────────────
   축이 둘이다. 테마는 형태와 색의 성격을 정하고, 모드는 그 테마의 밝은 쪽과
   어두운 쪽 중 하나를 고른다. 모든 테마가 양쪽을 다 가진다 — 한쪽이 없어
   다른 쪽으로 대신하는 경우는 없다.

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
 * 지금 걸린 설정. 하나의 객체이고, 그대로 JSON 이다.
 *
 * 값마다 변수를 두면 저장할 때 목록을 따로 적어야 하고, 하나 늘 때마다 그
 * 목록을 고쳐야 한다. 여기서는 이 객체가 곧 저장 형식이다.
 */
const settings = {
  theme: THEMES[0].name,
  mode: "dark",

  /* 프로젝트 탭이 어디 서는가. top = 크롬 줄, left = 왼쪽 세로 레일. */
  projectTabs: "top",
  /* 레일이 포커스를 따라가는가. flow = 따라간다, pin = 자리를 지킨다,
     off = 서지 않는다. */
  rail: "flow",
  /* 좌·우 영역을 여는가. 무엇이 서는지는 연결이 정하고, 이것은 자리 자체다. */
  left: true,
  right: true,
  /* 포커스를 잃은 표면을 흐리게 하는가. */
  dim: false,
  /* 포커스 카드를 무엇으로 표시하는가 — 테두리인가 네 꼭짓점의 꺽쇠인가. */
  focusInd: "border",
  /* 카드 사이의 경계선을 그리는가. */
  fullRule: "hide",
  /* 통로의 절반 폭(px). 테마를 고르면 그 테마의 값이 되고, 그 뒤에 사람이
     옮기면 옮긴 값이다. */
  gap: parseFloat(THEMES[0].shape.gap),

  /* 사이드바는 조합해서 만든다. 세트 하나가 섹션들을 골라 순서대로 담고,
     연결이 그 세트를 어느 자리에 건다.

     세트는 제목이 아니라 id 로 걸린다 — 같은 제목의 세트가 둘 있을 수 있다. */
  sets: [
    { id: "set-install", title: "탐색기", sections: ["files.tree", "files.bookmarks"] },
    { id: "set-shell", title: "셸", sections: ["terminal.history", "terminal.cwd"] },
    { id: "set-process", title: "프로세스", sections: ["terminal.pty", "terminal.jobs"] },
    { id: "set-page", title: "페이지", sections: ["browser.dom", "browser.network"] },
    { id: "set-browser", title: "브라우저", sections: ["browser.tabs", "browser.history"] },
  ],

  /* 어느 세트가 어디에 서는가. `plugin` 이 null 인 자리는 포커스를 따르지
     않는다 — 좌측이 그렇다.

     여기 없는 자리는 사이드바가 없다. set-page 는 만들어져 있지만 걸려 있지
     않으므로 브라우저 레일은 서지 않는다. */
  links: [
    { place: "left", plugin: null, set: "set-install" },
    { place: "rail", plugin: "terminal", set: "set-shell" },
    { place: "right", plugin: "terminal", set: "set-process" },
    { place: "right", plugin: "browser", set: "set-browser" },
  ],
};

/** 이름으로 찾은 테마. 목록에 없는 이름은 부르는 쪽의 잘못이므로 실패한다. */
function themeOf(name) {
  const found = THEMES.find((t) => t.name === name);
  if (!found) throw new Error(`unknown theme: ${name}`);
  return found;
}

/** 지금 걸려 있는 값들. 표면과 모달이 같은 것을 받는다. */
function themeTokens() {
  const theme = themeOf(settings.theme);
  const c = theme[settings.mode];
  return {
    "--bg": c.bg, "--card": c.card, "--fg": c.fg, "--muted": c.muted,
    "--bd": c.bd, "--rail": c.rail, "--focus": c.focus, "--ok": c.ok,
    "--no": c.no, "--surface": c.surface, "--surface-fg": c.surfaceFg,
    "--r": theme.shape.r, "--half-gap": theme.shape.gap, "--bw": theme.shape.bw,
  };
}

/* 호스트가 만드는 페이지들은 각자 다른 문서라 이 문서의 스타일시트를 물려받지
   못한다. 그래서 값을 실어 보내고, 그쪽에서 자기 루트에 심는다. */
window.pageTheme = () => ({ scheme: settings.mode, tokens: themeTokens() });

/**
 * 테마와 모드를 건다.
 *
 * 값은 루트에 심는다 — 스타일시트를 갈아 끼우지 않으므로, 사람이 색 입력으로
 * 고른 값이 있으면 그것이 그대로 이긴다.
 */
export function applyTheme(name, next) {
  if (!MODES.includes(next)) throw new Error(`unknown mode: ${next}`);
  const theme = themeOf(name);
  // 통로는 테마가 정한다. 테마를 고르는 것이 통로를 고르는 것이기도 하다.
  set({ theme: theme.name, mode: next, gap: parseFloat(theme.shape.gap) });
}

/** 지금 값 하나를 읽는다. */
export const value = (key) => settings[key];

/**
 * 설정의 일부를 바꾼다. 값을 심고, 듣는 쪽에 알린다.
 *
 * 바꾸는 경로는 이것 하나다. 값마다 함수를 두면 심는 것을 빠뜨린 함수가
 * 생긴다.
 */
export function set(patch) {
  Object.assign(settings, patch);
  install();
  // 통로는 배치가 읽는 값이므로 설정이 바뀌면 판도 바뀐다. 그 일은 듣는 쪽이
  // 한다 — 여기서는 바뀌었다는 사실만 알린다.
  announce();
}

/** 값을 문서 루트에 심는다. 시작할 때 한 번, 그 뒤로는 바뀔 때마다. */
export function install() {
  const root = document.documentElement;
  root.style.colorScheme = settings.mode;
  // 스타일시트가 읽는 두 값. 보이는 것만 바꾸므로 판을 다시 세우지 않는다.
  root.dataset.focusInd = settings.focusInd;
  root.dataset.fullRule = settings.fullRule;
  root.style.setProperty("--half-gap", `${settings.gap}px`);
  for (const [token, value] of Object.entries(themeTokens())) {
    root.style.setProperty(token, value);
  }
  // 호스트가 그리는 페이지들은 이 문서의 스타일시트를 물려받지 못하므로 값을
  // 따로 받는다. 테마는 사람이 고를 때만 바뀌므로 그때 한 번만 보낸다.
  window.hostSurfaces?.theme?.(window.pageTheme());
}
/** 카드의 모서리 반경. 테마가 정하므로 상수로 둘 수 없다. */
export const cardRadius = () =>
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--r")) || 0;

/* 값이 바뀌었음을 듣는 쪽. 판 하나가 붙는다. */
let listener = null;

/** 값이 바뀌면 부를 함수를 건다. */
export function onSettingsChange(fn) {
  listener = fn;
}

const announce = () => listener?.();

/** 조합해 둔 세트 전부. 사이드바를 편집할 때 고르는 목록이다. */
export const sets = () => settings.sets;

/**
 * 세트를 자리에 건다. `setId` 가 null 이면 연결을 끊는다 — 그러면 그 사이드바는
 * 없다.
 */
export function link(place, plugin, setId) {
  const rest = settings.links.filter((l) => !(l.place === place && l.plugin === plugin));
  set({ links: setId === null ? rest : [...rest, { place, plugin, set: setId }] });
}

/** 그 자리에 걸린 세트의 id. 없으면 null. */
export function linkedId(place, plugin) {
  const found = settings.links.find((l) => l.place === place && l.plugin === plugin);
  return found ? found.set : null;
}

/**
 * 그 자리에 걸린 세트. 걸린 것이 없으면 null — 연결하지 않으면 그 사이드바는
 * 없다.
 *
 * 섹션의 이름까지 여기서 읽지는 않는다. 무엇이 등록되어 있는지는 레지스트리가
 * 알고, 설정은 어느 것을 골랐는지만 안다.
 */
export function linkedSet(place, plugin) {
  const link = settings.links.find((l) => l.place === place && l.plugin === plugin);
  if (!link) return null;
  const set = settings.sets.find((s) => s.id === link.set);
  if (!set) throw new Error(`link points at a set that is gone: ${link.set}`);
  return set;
}

/** 지금 걸린 테마의 이름과 모드. 배선이 select 를 맞출 때 읽는다. */
export const themeName = () => settings.theme;
export const modeName = () => settings.mode;

/** 이 테마가 정한 통로의 절반 폭(px). 판이 gap 과 bleed 를 여기서 얻는다. */
export const halfGap = () => settings.gap;

