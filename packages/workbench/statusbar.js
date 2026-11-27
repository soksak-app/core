// The status bar at the bottom of the main window (docs/spec/external-sidebars.md#status-bar): the project name, the card count, the theme
// and the mode of the window, and the key hint of the settings. Each text is read from its status when the bar is drawn.

/**
 * Creates the bar in root. project() gives the project of the window or null, cards() the number of cards of the grid, and theme() and
 * mode() the applied values of the settings. draw(visible) shows the bar and writes its texts, or hides it when visible is false.
 */
export function createStatusBar(root, { project, cards, theme, mode }) {
  root.className = "statusbar";
  root.innerHTML = [
    '<button class="statusbar__item statusbar__home" type="button" data-expose="core.statusbar.home">홈</button>',
    '<span class="statusbar__item" data-expose="core.statusbar.project"></span>',
    '<span class="statusbar__item" data-expose="core.statusbar.cards"></span>',
    '<span class="statusbar__item" data-expose="core.statusbar.theme"></span>',
    '<span class="statusbar__spacer"></span>',
    '<span class="statusbar__key">⌘, 설정</span>',
  ].join("");
  const projectItem = root.querySelector('[data-expose="core.statusbar.project"]');
  const cardsItem = root.querySelector('[data-expose="core.statusbar.cards"]');
  const themeItem = root.querySelector('[data-expose="core.statusbar.theme"]');
  return {
    draw(visible) {
      root.hidden = !visible;
      if (!visible) return;
      const current = project();
      projectItem.hidden = current === null;
      projectItem.textContent = current === null ? "" : current.title;
      cardsItem.textContent = `카드 ${cards()}`;
      themeItem.textContent = `${theme()} · ${mode()}`;
    },
  };
}

/**
 * Creates the status line of the project home (docs/spec/external-sidebars.md#status-bar): the number of projects, the number of open
 * projects, the enabled and installed plugins, the button back to the work screen and the button for a new window. count() and open() give
 * the two numbers of projects, plugins() gives the enabled and the installed plugin counts, and canReturn() tells whether the window has a
 * work screen to return to. draw(visible) shows the line and writes its texts, or hides it when visible is false.
 */
export function createHomeStatusBar(root, { count, open, plugins, canReturn }) {
  root.className = "statusbar";
  root.innerHTML = [
    '<span class="statusbar__item" data-expose="core.home.status.projects"></span>',
    '<span class="statusbar__sep">·</span>',
    '<span class="statusbar__item" data-expose="core.home.status.open"></span>',
    '<span class="statusbar__item" data-expose="core.home.status.plugins"></span>',
    '<button class="statusbar__item" type="button" data-expose="core.home.status.back">← 작업 화면으로</button>',
    '<span class="statusbar__spacer"></span>',
    '<button class="statusbar__item" type="button" data-expose="core.home.status.new">+ 새 창</button>',
  ].join("");
  const projectsItem = root.querySelector('[data-expose="core.home.status.projects"]');
  const openItem = root.querySelector('[data-expose="core.home.status.open"]');
  const pluginsItem = root.querySelector('[data-expose="core.home.status.plugins"]');
  const backItem = root.querySelector('[data-expose="core.home.status.back"]');
  return {
    draw(visible) {
      root.hidden = !visible;
      if (!visible) return;
      projectsItem.textContent = `프로젝트 ${count()}`;
      openItem.textContent = `열림 ${open()}`;
      const { enabled, installed } = plugins();
      pluginsItem.textContent = `플러그인 ${enabled}/${installed}`;
      backItem.hidden = !canReturn();
    },
  };
}
