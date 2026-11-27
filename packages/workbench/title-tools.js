// The tools of the title bar for the screen in front (docs/spec/external-sidebars.md#window-tools): the work screen shows the four side
// switches, a separator and the settings button; the project home shows the settings button; the settings tab in front shows none.
// The bell is the last element of the title bar on every screen.

/** Returns the tool elements of the title bar in their order: the tools of the screen in front, then the bell. */
export function titleTools({ front, browsing, sidebarButtons, separator, settingsButton, bell }) {
  const screen = front ? [] : browsing ? [settingsButton] : [...sidebarButtons, separator, settingsButton];
  return [...screen, bell];
}
