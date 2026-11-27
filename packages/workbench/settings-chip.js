// The settings tab chip beside the project tabs, and the container that the settings content is mounted into (docs/spec/settings.md#opening-and-closing).
// The settings module supplies the content and its state: mount(container) draws the content, front() tells whether the settings tab is in front,
// and open() tells whether the window has a settings tab. Each is injected so that the chip depends on no module that does not yet export it.
import { bind } from "./commands.js";
import { icon } from "./icons.js";

/**
 * The value of body[data-screen]: the settings tab is a tab of the work screen, so while it is in front on the project home, the
 * body shows the work screen and the project home stays hidden (docs/spec/external-sidebars.md#window-tools).
 */
export function screenOfWindow({ browsing, settingsFront }) {
  return browsing && !settingsFront ? "home" : "workspace";
}

/**
 * Draws the chip into root and returns the state it draws. root holds the chip button and the close control; the content container is
 * the element that the settings module mounts into while the settings tab is in front.
 */
export function createSettingsChip(root, container, { mount, front, open, hint = null }) {
  if (typeof mount !== "function" || typeof front !== "function" || typeof open !== "function") {
    throw new Error("the settings chip needs the mount, front and open functions of the settings module");
  }
  root.innerHTML = `<button type="button" class="settings-chip__open" data-expose="core.settings-tab.chip">${icon("settings")}설정</button><button type="button" class="settings-chip__close" data-expose="core.settings-tab.close" aria-label="설정 탭 닫기">×</button>`;
  const openButton = root.querySelector(".settings-chip__open");
  const closeButton = root.querySelector(".settings-chip__close");
  bind(openButton, "core.settings.open", {});
  bind(closeButton, "core.settings.close", {});
  let mounted = false;
  // A window that has closed its settings tab shows the hint on the work screen until the tab opens again (docs/spec/settings.md#opening-and-closing).
  // Nothing is stored: the hint depends on whether this page has opened the tab, so a window that never opened it shows no hint.
  let opened = false;
  let closed = false;
  if (hint) {
    hint.className = "closed-hint";
    hint.innerHTML = '<span class="closed-hint__text">설정이 닫혀 있다</span><button type="button" class="closed-hint__open" data-expose="core.settings-tab.reopen">설정 열기</button>';
    bind(hint.querySelector(".closed-hint__open"), "core.settings.open", {});
  }
  /** Draws the chip for the current state. The content is mounted once, the first time the settings tab is in front. work tells whether the work screen is in front, where the hint shows. */
  function draw(work = false) {
    const shown = open();
    root.hidden = !shown;
    const isFront = shown && front();
    root.dataset.on = String(isFront);
    container.hidden = !isFront;
    // While the tab is in front, the work surfaces are not drawn; the window hides them through the work screen.
    if (isFront && !mounted) { mount(container); mounted = true; }
    if (shown) opened = true;
    closed = opened && !shown;
    if (hint) hint.hidden = !(closed && work);
    return { open: shown, front: isFront, closed };
  }
  return { draw, state: () => ({ open: !root.hidden, front: root.dataset.on === "true", closed }) };
}
