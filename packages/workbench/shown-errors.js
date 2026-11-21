// The only path that shows an error to the user. The next drawing or reload erases the error display on the screen, so the record written to the application
// log at the moment it is shown is the trace of that error (AGENTS.md, docs/spec/hosts.md#application-log). The error color is used only for the
// `data-error` element that this path attaches. Drawing the same error again at the same place does not write it again.
import { report } from "./host.js";
import { delegate, mark } from "./commands.js";

const shown = new Map();

/**
 * Shows the error text of the place where on the element element, and writes `error: <where>: <text><detail>` only when the error of that place changed.
 * detail is a detail (the location or stack of the error) that is not shown on the screen and is kept only in the log.
 */
export function showError(element, where, text, detail = "") {
  drawError(element, where, text);
  if (shown.get(where) === text) return;
  shown.set(where, text);
  report(`${where}: ${text}${detail}`);
}

/** Withdraws the error display of the place where. A place that is not drawn, with no element, can be withdrawn too. If the same error is shown next time, it is written again. */
export function hideError(element, where) {
  if (element) delete element.dataset.error;
  shown.delete(where);
}

function drawError(element, where, text) {
  element.textContent = text;
  element.dataset.error = where;
  element.hidden = false;
}

const documents = new WeakMap();

/** Returns the error toast component for a document. */
export function errorToasts(document) {
  if (!documents.has(document)) documents.set(document, createErrorToasts(document));
  return documents.get(document);
}

function createErrorToasts(document) {
  const origins = new Map();
  const groups = new Map();
  const watchers = new Set();
  let container = document.body;
  let holder;
  let nextToast = 0;

  function changed() {
    for (const watcher of watchers) watcher();
  }

  function open(text, where) {
    const node = toast(document, text, where, ++nextToast);
    if (!holder) {
      holder = document.createElement("div");
      holder.id = "errorToasts";
      holder.setAttribute("role", "alert");
      delegate(holder);
      // The surrounding dialog may also delegate its controls. A toast close belongs to this holder.
      holder.addEventListener("click", (event) => {
        if (event.target.closest(".error-toast__close")) event.stopPropagation();
      });
    }
    if (holder.parentElement !== container) container.append(holder);
    holder.append(node);
    const group = { text, node, origins: new Set(), anonymous: false };
    groups.set(text, group);
    return group;
  }

  function close(group) {
    group.node.remove();
    groups.delete(group.text);
    if (groups.size === 0) holder.remove();
  }

  function detach(origin, { group }) {
    if (!group) return false;
    group.origins.delete(origin);
    if (group.origins.size !== 0 || group.anonymous) return false;
    close(group);
    return true;
  }

  return {
    /**
     * Shows the failure of a named origin until that origin changes or recovers. A failure without an origin is
     * grouped by its text while its toast is open. The location and detail are recorded in the application log.
     */
    show(reason, detail = "", origin = "", where = "workbench") {
      const text = String(reason);
      const previous = origins.get(origin);
      if (previous?.text === text) return;
      const existing = groups.get(text);
      if (!origin && existing?.anonymous) return;
      const group = existing ?? open(text, where);
      let changedGroups = !existing;
      if (origin) {
        if (previous && detach(origin, previous)) changedGroups = true;
        origins.set(origin, { text, group });
        group.origins.add(origin);
      } else {
        group.anonymous = true;
      }
      if (origin || !existing) report(`${where}: ${text}${detail}`);
      if (changedGroups) changed();
    },

    /** Withdraws the occurrence when its origin recovers. */
    withdraw(origin) {
      const occurrence = origins.get(origin);
      if (!occurrence) return;
      origins.delete(origin);
      if (detach(origin, occurrence)) changed();
    },

    /** Dismisses every occurrence in the visible toast. The named occurrences remain active until they recover. */
    dismiss(text) {
      const group = groups.get(text);
      if (!group) return false;
      for (const origin of group.origins) origins.get(origin).group = null;
      close(group);
      changed();
      return true;
    },

    /** Returns the current error of the origin, including a dismissed occurrence. */
    text: (origin) => origins.get(origin)?.text ?? null,

    newest: () => Array.from(groups.keys()).at(-1) ?? null,

    /** Moves the existing stack to the foreground content without changing its occurrences. */
    place(root) {
      if (root === container) return;
      container = root;
      if (groups.size > 0) container.append(holder);
    },

    watch(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
  };
}

function toast(document, text, where, id) {
  const toast = document.createElement("div");
  toast.className = "error-toast";
  toast.dataset.text = text;
  const shown = document.createElement("span");
  shown.className = "error-toast__text";
  drawError(shown, where, text);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "error-toast__close";
  close.dataset.key = `error-toast:${id}`;
  close.dataset.expose = "core.error.dismiss";
  close.title = "오류 닫기";
  close.setAttribute("aria-label", close.title);
  close.textContent = "×";
  mark(close, "core.error.dismiss", { text });
  toast.append(shown, close);
  return toast;
}
