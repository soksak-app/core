// The drawn notices of the window (docs/spec/notifications.md): the toasts under the bell in the three forms, the notice center in the popover
// or the drawer form, and the bell. The store (notices.js) decides what shows; this module only draws the state it reports and turns each press
// into a declared command. Elements are bound through the shared binder, so every press runs a declared command (AGENTS.md).
import { bind, mark } from "./commands.js";
import { icon } from "./icons.js";
import { onTabReports, onToastChange } from "./tab-reports.js";
import { value as settingValue } from "./settings.js";

// The glyph of each kind; the color is never the only mark (docs/spec/notifications.md#notices).
const GLYPH = { success: "notice-success", info: "notice-info", warning: "notice-warning", error: "notice-error" };
const GROUP_LABEL = { progress: "진행 중", today: "오늘", yesterday: "어제" };
const FILTER_LABEL = { all: "전체", problems: "오류·경고", progress: "진행 중" };
const FILTERS = ["all", "problems", "progress"];
const TOAST_LIMIT = 3;

const el = (document, tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// The element of a declared name, with the command it runs and its parameters.
function control(document, tag, className, label, name, command, params) {
  const node = el(document, tag, className, label);
  if (tag === "button") node.type = "button";
  node.dataset.expose = name;
  bind(node, command, params);
  return node;
}

// A press on an element that a notice holds: the pointer and the keyboard focus pause the timers of that notice.
function holdWhile(node, store, id) {
  let pointer = false;
  let focus = false;
  const apply = () => store.hold(id, pointer || focus);
  node.addEventListener("pointerenter", () => { if (!pointer) { pointer = true; apply(); } });
  node.addEventListener("pointerleave", () => { if (pointer) { pointer = false; apply(); } });
  node.addEventListener("focusin", () => { if (!focus) { focus = true; apply(); } });
  node.addEventListener("focusout", () => { if (focus) { focus = false; apply(); } });
  return () => { if (pointer || focus) { pointer = false; focus = false; store.hold(id, false); } };
}

/** The bell of the title bar: the element core.chrome.notices, which runs core.notices.toggle and shows the unread entries (docs/spec/notifications.md#bell). */
export function createBell(document, store) {
  const button = control(document, "button", "act notice-bell", "알림 센터", "core.chrome.notices", "core.notices.toggle", {});
  button.innerHTML = `${icon("bell")}<span class="notice-bell__count" hidden></span>`;
  button.dataset.on = "false";
  const count = button.querySelector(".notice-bell__count");
  button.refresh = () => {
    const status = store.status();
    count.hidden = status.unread === 0;
    count.textContent = String(status.unread);
    button.dataset.tone = status.problems ? "problem" : "accent";
    button.dataset.on = String(status.open);
    button.title = status.unread === 0 ? "알림 센터" : `알림 센터, 읽지 않음 ${status.unread}개`;
  };
  return button;
}

/**
 * The status line of a card notice: the dot of its kind, the tab name when the notice comes from a tab that is not the active tab of its
 * card (tabName, else null), the title, the text, the first action in brackets and the close control, separated by middots
 * (docs/spec/notifications.md#card-status-line). The line is the element core.card.notice.
 */
export function cardNoticeLine(document, store, notice, tabName = null) {
  const line = el(document, "div", "notice-line");
  line.dataset.notice = notice.id;
  line.dataset.kind = notice.kind;
  line.dataset.expose = "core.card.notice";
  line.append(el(document, "span", "notice-line__dot"));
  const parts = [];
  if (tabName !== null) parts.push(el(document, "span", "notice-line__tab", tabName));
  parts.push(el(document, "span", "notice-line__title", notice.base));
  if (notice.text !== "") parts.push(el(document, "span", "notice-line__text", notice.text));
  const [action] = notice.actions;
  if (action) parts.push(control(document, "button", "notice-line__action", `[${action.label}]`, "core.notices.action", action.command, action.params ?? {}));
  parts.push(control(document, "button", "notice-line__close", "×", "core.notices.close", "core.notices.close", { id: notice.id }));
  parts.forEach((part, index) => {
    if (index > 0) {
      const separator = el(document, "span", "notice-line__sep", " · ");
      separator.setAttribute("aria-hidden", "true");
      line.append(separator);
    }
    line.append(part);
  });
  line.setAttribute("role", notice.kind === "error" ? "alert" : "status");
  return line;
}

/** Draws the toasts, the center and the bell of the document. The page redraws them on each change of the notices. */
export function mountNoticeView(document, store) {
  const holder = el(document, "div", "toasts");
  holder.id = "toasts";
  const toastNodes = new Map();
  // The counter of the toasts that do not show, made at the first draw, when the core commands are declared: a press opens the notice
  // center (docs/spec/notifications.md#toasts).
  let counter = null;
  let container = document.body;
  let center = null;

  // A toast element keeps its identity across redraws, so the pointer and the focus on it are not lost.
  function toastNode(notice) {
    if (toastNodes.has(notice.id)) return toastNodes.get(notice.id);
    const node = el(document, "div", "toast");
    node.dataset.notice = notice.id;
    const body = el(document, "div", "toast__body");
    const head = el(document, "div", "toast__head");
    const mark = el(document, "span", "toast__mark");
    mark.innerHTML = icon(GLYPH[notice.kind] ?? "notice-info");
    head.append(mark, el(document, "span", "toast__title"));
    const message = el(document, "div", "toast__text");
    const actions = el(document, "div", "toast__actions");
    body.append(head, message, actions);
    const close = control(document, "button", "toast__close", "닫기", "core.notices.close", "core.notices.close", { id: notice.id });
    close.setAttribute("aria-label", "닫기");
    // The key of the close control is the notice id, which a modal answer names (obsoleteClose in host.js checks it).
    close.dataset.key = notice.id;
    close.innerHTML = icon("close");
    const bar = el(document, "div", "toast__bar");
    node.append(body, close, bar);
    node.release = holdWhile(node, store, notice.id);
    node.setAttribute("role", notice.kind === "error" ? "alert" : "status");
    toastNodes.set(notice.id, node);
    return node;
  }

  // The remaining time that each toast node last ran its bar for; kept outside the DOM so that it is not drawn.
  const barRemaining = new WeakMap();

  // Draws the content of a toast from the notice record, with the first action only in the line form.
  function fill(node, notice, toast, style) {
    node.dataset.kind = notice.kind;
    node.querySelector(".toast__title").textContent = toast.title;
    node.querySelector(".toast__text").textContent = notice.text;
    node.querySelector(".toast__text").hidden = notice.text === "";
    const actions = node.querySelector(".toast__actions");
    actions.replaceChildren();
    const shown = style === "line" ? notice.actions.slice(0, 1) : notice.actions;
    for (const action of shown) {
      const button = control(document, "button", "toast__action", action.label, "core.notices.action", action.command, action.params ?? {});
      button.dataset.id = notice.id;
      // Running an action closes its toast (docs/spec/notifications.md#toasts).
      button.addEventListener("click", () => store.close(notice.id));
      actions.append(button);
    }
    actions.hidden = shown.length === 0;
    const bar = node.querySelector(".toast__bar");
    bar.hidden = toast.remaining === null;
    // The bar runs for the remaining time at its first draw and again when a restart raises the remaining time. A redraw with a lower remaining
    // time writes nothing, so the drawn HTML carries no timer-driven width (docs/spec/notifications.md#toasts).
    const drawnFor = barRemaining.get(node) ?? null;
    if ((toast.remaining !== null && drawnFor === null) || (toast.remaining !== null && toast.remaining > drawnFor)) {
      bar.style.animationDuration = `${toast.remaining}ms`;
    }
    barRemaining.set(node, toast.remaining);
  }

  function drawToasts() {
    const style = settingValue("toastStyle");
    const toasts = store.toasts();
    const live = new Set(toasts.map((t) => t.id));
    for (const [id, node] of toastNodes) {
      if (live.has(id)) continue;
      node.release();
      node.remove();
      toastNodes.delete(id);
    }
    holder.dataset.style = style;
    const nodes = toasts.map((toast) => {
      const notice = store.notice(toast.id);
      const node = toastNode(notice);
      fill(node, notice, toast, style);
      return node;
    });
    // card shows three toasts and counts the rest; line shows one; deck shows the stack, which CSS spreads on hover.
    const shown = style === "card" ? nodes.slice(0, TOAST_LIMIT) : style === "line" ? nodes.slice(0, 1) : nodes;
    const rest = nodes.length - shown.length;
    for (const node of nodes) if (!shown.includes(node)) node.release();
    counter ??= control(document, "button", "toast__more", "", "core.notices.panel", "core.notices.toggle", {});
    counter.hidden = rest === 0;
    counter.textContent = style === "line" ? String(rest) : `+${rest}개 더`;
    // The line form shows the count of the other notices in the error tone (docs/spec/notifications.md#toasts).
    if (style === "line") counter.dataset.tone = "error";
    else delete counter.dataset.tone;
    holder.replaceChildren(...shown, counter);
    holder.hidden = nodes.length === 0;
    if (holder.parentElement !== container) container.append(holder);
    if (holder.parentElement !== container) container.append(holder);
  }

  function drawCenter() {
    const status = store.status();
    // The entries with their group: status() reports the entries of core.notices without the group, which the groups need.
    const entries = store.entries();
    if (!status.open) {
      center?.remove();
      center = null;
      return;
    }
    if (!center) center = el(document, "section", "notice-center");
    center.dataset.style = status.style;
    center.dataset.expose = "core.notices.panel";
    center.setAttribute("aria-label", "알림");
    const head = el(document, "header", "notice-center__head");
    head.append(el(document, "strong", "notice-center__title", "알림"));
    head.append(control(document, "button", "notice-center__read", "모두 읽음", "core.notices.read-all", "core.notices.read-all", {}));
    head.append(control(document, "button", "notice-center__settings", "⚙", "core.notices.settings", "core.settings.open", {}));
    head.append(control(document, "button", "notice-center__close", "", "core.notices.toggle", "core.notices.toggle", {}));
    head.querySelector(".notice-center__close").innerHTML = icon("close");
    const filters = el(document, "div", "notice-center__filters");
    for (const filter of FILTERS) {
      const count = entries.filter((e) => (filter === "all" ? true : filter === "problems" ? e.kind === "warning" || e.kind === "error" : e.kind === "progress")).length;
      const button = control(document, "button", "notice-center__filter", `${FILTER_LABEL[filter]} ${count}`, "core.notices.filter", "core.notices.filter", { filter });
      button.setAttribute("aria-pressed", String(status.filter === filter));
      filters.append(button);
    }
    const groups = el(document, "div", "notice-center__groups");
    const shownEntries = entries.filter((e) => status.filter === "all" || (status.filter === "problems" ? e.kind === "warning" || e.kind === "error" : e.kind === "progress"));
    const order = ["progress", ...new Set(shownEntries.map((e) => e.group).filter((g) => g !== "progress"))];
    for (const group of order) {
      const entries = shownEntries.filter((e) => e.group === group);
      if (entries.length === 0) continue;
      const section = el(document, "section", "notice-center__group");
      const label = el(document, "div", "notice-center__label");
      label.append(el(document, "span", "", GROUP_LABEL[group] ?? group));
      if (group !== "progress") label.append(control(document, "button", "notice-center__clear", "지우기", "core.notices.clear", "core.notices.clear", { group }));
      section.append(label);
      for (const entry of entries) section.append(entryNode(entry));
      groups.append(section);
    }
    const foot = el(document, "footer", "notice-center__foot");
    foot.append(el(document, "span", "", "오류는 지울 때까지, 나머지는 7일 동안 남는다."));
    foot.append(control(document, "button", "notice-center__clear-all", "모두 지우기", "core.notices.clear-all", "core.notices.clear-all", {}));
    center.replaceChildren(head, filters, groups, foot);
    if (center.parentElement !== container) container.append(center);
  }

  function entryNode(entry) {
    const node = el(document, "div", "notice-center__entry");
    node.dataset.kind = entry.kind;
    node.dataset.id = entry.id;
    node.dataset.read = String(entry.read);
    const mark = el(document, "span", "notice-center__mark");
    mark.innerHTML = icon(GLYPH[entry.kind] ?? "notice-info");
    const body = el(document, "div", "notice-center__body");
    body.append(el(document, "div", "notice-center__title", entry.title));
    if (entry.text) body.append(el(document, "div", "notice-center__text", entry.text));
    if (entry.kind === "progress") {
      const bar = el(document, "progress", "notice-center__progress");
      bar.max = 1;
      if (entry.progress !== null) bar.value = entry.progress;
      body.append(bar);
    }
    const meta = el(document, "div", "notice-center__meta");
    meta.append(el(document, "span", "notice-center__source", sourceChip(entry.source)));
    meta.append(el(document, "time", "", new Date(entry.at).toTimeString().slice(0, 5)));
    body.append(meta);
    const actions = el(document, "div", "notice-center__actions");
    for (const action of entry.actions) actions.append(control(document, "button", "toast__action", action.label, "core.notices.action", action.command, action.params ?? {}));
    body.append(actions);
    node.append(mark, body);
    // A press on the entry reads it (core.notices.read); the press on a card entry also focuses its card (docs/spec/notifications.md#notice-center).
    node.dataset.expose = "core.notices.entry";
    bind(node, "core.notices.read", { id: entry.id });
    if (entry.source.kind === "card") {
      node.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        store.focusCard(entry.source.card);
      });
    }
    return node;
  }

  const sourceChip = (source) => {
    if (source.kind === "card") return source.card;
    if (source.kind === "plugin") return source.plugin;
    if (source.kind === "settings") return "설정";
    return "soksak";
  };

  function redrawCenter() {
    drawCenter();
    for (const bell of document.querySelectorAll(".notice-bell")) bell.refresh?.();
  }

  function redraw() {
    drawToasts();
    redrawCenter();
  }

  // The toasts lie in front of the foreground content of a dialog or the window, and keep the same stack (errors.place).
  // The toast bar redraws only when the shown toasts change; the center and the bell redraw on every change of an entry.
  onToastChange(drawToasts);
  onTabReports(redrawCenter);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && store.status().open) store.toggle();
  });

  return {
    redraw,
    place(root) {
      if (root === container) return;
      container = root;
      if (holder.childElementCount > 0) container.append(holder);
      if (center) container.append(center);
    },
    // A key that is not a notice id answers another control, so it is not an obsolete close (host.js passes it on).
    obsoleteClose(key, root) {
      if (!/^notice-\d+$/.test(key)) return false;
      return !store.toasts().some((t) => t.id === key) || !(root?.querySelector(`[data-notice="${key}"]`));
    },
  };
}

