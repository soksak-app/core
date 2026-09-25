// 파일 트리 섹션. 상태 모듈이 공개한 files.tree 와 files.git 을 @pierre/trees 의 트리로 그린다.
//
// 목록은 상태 모듈이 갖는다. 사람이 트리에서 폴더를 열거나 닫으면 files.tree.toggle 을 실행하고, 상태가
// 그 폴더를 나열하면 바뀐 경로만 트리에 더하거나 뺀다. 색은 앱의 테마 토큰에 묶는다.
import { FileTree, themeToTreeStyles } from "../vendor/trees.js";
import { PLACEHOLDER, expansionRequests, pathDiff, treePaths } from "./tree-paths.js";

/* 트리 안의 4pt 스크롤 막대. */
const SCROLLBAR = `
::-webkit-scrollbar{-webkit-appearance:none;width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(127,127,127,0.22);border-radius:2px}
::-webkit-scrollbar-thumb:hover{background:rgba(127,127,127,0.42)}
::-webkit-scrollbar-corner{background:transparent}
`;

/*
 * 섹션의 스타일. 이 섹션의 요소에만 적용된다. 문서의 stylesheet 로 두어 섹션의 텍스트에 섞이지 않는다.
 *
 * 가로 격자는 하나다. 섹션 본문은 트리 둘레에 여백을 두지 않는다. 섹션 머리의 접기 표시는 사이드바 가장자리에서
 * GUTTER 떨어진 상자에 그려지고, 그 획은 상자 왼쪽에서 CHEVRON_INK 안쪽에서 시작한다. 머리 글자와 트리 행의 접기
 * 표시는 그 획과 같은 열에서 시작하도록 각자의 획 여백(TITLE_INK, ROW_INK)을 뺀 자리에 둔다. 값은 두 앱의 캡처에서
 * 쟀다(e2e/files.test.mjs). 머리의 단추는 카드 머리 단추(.chrome__act)의 크기와 색이다.
 */
const GUTTER = 10;
const CHEVRON_INK = 2.5;
const TITLE_INK = 1;
const ROW_INK = 5.5;
const STYLE = `
.set__section[data-section="files.tree"] > .set__body{padding:0;overflow:hidden}
.files-tree{display:flex;flex-direction:column;height:100%;min-width:0}
.files-tree__head{display:flex;align-items:center;gap:1px;flex:0 0 auto;height:28px;padding:0 ${GUTTER - 4}px 0 ${GUTTER + CHEVRON_INK - TITLE_INK}px}
.files-tree__title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)}
.files-tree__button{display:grid;place-items:center;width:20px;height:20px;padding:0;border:0;border-radius:var(--r-xs);
  background:transparent;color:var(--muted);cursor:pointer}
.files-tree__button svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round}
.files-tree__button:hover:not(:disabled){background:var(--inset);color:var(--fg)}
.files-tree__button:disabled{opacity:.4;cursor:default}
.files-tree__holder{flex:1 1 auto;min-height:0}
.files-tree__message{padding:0 ${GUTTER + CHEVRON_INK - TITLE_INK}px;color:var(--muted)}
`;

/* 사이드바 목록의 행 높이(12px 글자 × 1.6 을 픽셀에 맞춘 값). */
const ROW_HEIGHT = 20;

/** 트리 색. 라이브러리 기본값이 드러나지 않도록 모든 색을 앱 토큰의 var() 로 준다. */
function themeStyles() {
  const style = getComputedStyle(document.documentElement);
  const mode = document.documentElement.dataset.mode === "light" ? "light" : "dark";
  return {
    ...themeToTreeStyles({ type: mode, bg: style.getPropertyValue("--card").trim(), fg: style.getPropertyValue("--fg").trim() }),
    // 행은 사이드바의 12px 글자와 행 높이다. 첫 표시는 GUTTER 에서 시작한다.
    "--trees-font-size-override": "12px",
    "--trees-font-family-override": "var(--font)",
    "--trees-padding-inline-override": "0px",
    "--trees-item-margin-x-override": "0px",
    "--trees-item-padding-x-override": `${GUTTER + CHEVRON_INK - ROW_INK}px`,
    "--trees-bg-override": "var(--card)",
    "--trees-bg-muted-override": "var(--inset)",
    "--trees-fg-override": "var(--fg)",
    "--trees-fg-muted-override": "var(--muted)",
    "--trees-accent-override": "var(--rail)",
    "--trees-border-color-override": "var(--edge)",
    "--trees-selected-bg-override": "var(--chip-sel)",
    "--trees-selected-fg-override": "var(--fg)",
    "color-scheme": mode,
  };
}

export function mount(root, context) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(STYLE);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const box = document.createElement("div");
  box.className = "files-tree";
  const head = document.createElement("div");
  head.className = "files-tree__head";
  const title = document.createElement("span");
  title.className = "files-tree__title";
  const star = document.createElement("button");
  star.type = "button";
  star.className = "files-tree__button";
  star.innerHTML = context.icon("star");
  star.title = "북마크 추가";
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "files-tree__button";
  refresh.innerHTML = context.icon("rotate-cw");
  refresh.title = "새로 고침";
  const holder = document.createElement("div");
  holder.className = "files-tree__holder";
  const message = document.createElement("div");
  message.className = "files-tree__message";
  head.append(title, star, refresh);
  box.append(head, holder, message);
  root.append(box);

  let selected = null;
  const failed = (error) => reportError(error);
  context.bind(star, "files.bookmarks.add", () => ({ path: selected }), { failed });
  context.bind(refresh, "files.refresh", {}, { failed });
  // 트리의 shadow root 안에서 연 폴더와 닫은 폴더는 holder 의 이벤트로 명령에 닿는다(docs/spec/plugins.md#sections).
  context.bind(holder, "files.tree.toggle", (event) => ({ path: event.detail.path }), { event: "files-toggle", failed });

  const tree = new FileTree({
    paths: [],
    density: "compact",
    itemHeight: ROW_HEIGHT,
    flattenEmptyDirectories: false,
    unsafeCSS: SCROLLBAR,
    onSelectionChange(paths) {
      const file = [...paths].reverse().find((path) => !path.endsWith(PLACEHOLDER) && tree.getItem(path)?.isDirectory() === false);
      selected = file ?? null;
      star.disabled = selected === null;
    },
  });
  tree.render({ containerWrapper: holder });
  star.disabled = true;

  const applyTheme = () => Object.entries(themeStyles()).forEach(([name, value]) => holder.style.setProperty(name, value));
  applyTheme();
  const themeWatch = new MutationObserver(applyTheme);
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-mode"] });

  let rows = [];
  let paths = [];
  let syncing = false;
  const pending = new Set();
  const isExpanded = (path) => tree.getItem(path)?.isExpanded?.() ?? false;
  const unsubscribe = tree.subscribe(() => {
    if (syncing) return;
    for (const path of expansionRequests(rows, isExpanded, pending)) {
      holder.dispatchEvent(new CustomEvent("files-toggle", { detail: { path } }));
    }
  });

  const stopTree = context.status("files.tree", (value, source) => {
    if (source === null || value.error !== null) {
      message.textContent = source === null ? "프로젝트 없음" : `오류: ${value.error}`;
      message.hidden = false;
      return;
    }
    message.hidden = true;
    title.textContent = value.root.split("/").filter(Boolean).at(-1) ?? value.root;
    title.title = value.root;
    rows = value.entries;
    const next = treePaths(rows);
    syncing = true;
    try {
      const operations = pathDiff(paths, next);
      if (operations.length) tree.batch(operations);
      paths = next;
      // 상태의 펼침을 트리에 옮긴다. 요청 중인 폴더는 상태가 따라올 때까지 사람이 둔 대로 둔다.
      for (const row of rows) {
        if (!row.directory || pending.has(row.path)) continue;
        const item = tree.getItem(row.path);
        if (!item?.isDirectory()) continue;
        if (row.expanded && !item.isExpanded()) item.expand();
        if (!row.expanded && item.isExpanded()) item.collapse();
      }
      for (const path of [...pending]) {
        const row = rows.find((item) => item.path === path);
        if (!row || row.expanded === isExpanded(path)) pending.delete(path);
      }
    } finally {
      syncing = false;
    }
  });
  const stopGit = context.status("files.git", (entries) => tree.setGitStatus(entries ?? []));

  return {
    dispose() {
      stopTree();
      stopGit();
      unsubscribe();
      themeWatch.disconnect();
      tree.cleanUp();
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((item) => item !== sheet);
      box.remove();
    },
  };
}
