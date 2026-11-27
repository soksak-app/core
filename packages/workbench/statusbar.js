// The status bar at the bottom of the main window (docs/spec/external-sidebars.md#status-bar): the project name, the card count, the theme
// and the mode of the window, and the key hint of the settings. Each text is read from its status when the bar is drawn.

/**
 * Creates the bar in root. project() gives the project of the window or null, cards() the number of cards of the grid, and theme() and
 * mode() the applied values of the settings. draw(visible) shows the bar and writes its texts, or hides it when visible is false.
 */
export function createStatusBar(root, { project, cards, theme, mode }) {
  root.className = "statusbar";
  root.innerHTML = [
    '<span class="statusbar__item" data-expose="core.statusbar.project"></span>',
    '<span class="statusbar__item" data-expose="core.statusbar.cards"></span>',
    '<span class="statusbar__item" data-expose="core.statusbar.theme"></span>',
    '<span class="statusbar__spacer"></span>',
    '<span class="statusbar__key">⌘, 설정</span>',
  ].join("");
  const [projectItem, cardsItem, themeItem] = root.querySelectorAll(".statusbar__item");
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
