// The notice store of the workbench (docs/spec/notifications.md). It keeps every notice, decides the places where each notice shows (a toast,
// a card status line, or only the notice center), runs the timers of the shown places and merges the occurrences of a shown notice. It has no
// element: the views read its state through status() and toasts() and redraw on each change. The application log is written here, one line
// when a notice appears or merges.
import { checkNotice } from "@soksak/plugin-api";

export const KINDS = Object.freeze(["success", "info", "warning", "error", "progress"]);
// The time that a success or an info notice shows as a toast, and on its card status line (docs/spec/notifications.md#places).
const TOAST_MS = 4000;
const LINE_MS = 6000;
// The time that an entry of a kind other than error stays in the center.
const CENTER_MS = 7 * 24 * 60 * 60 * 1000;
const FILTERS = Object.freeze(["all", "problems", "progress"]);
const GROUP_PATTERN = /^(today|yesterday|\d{4}-\d{2}-\d{2})$/;
const SOURCE_KINDS = Object.freeze(["card", "plugin", "settings", "core"]);

// The local day of a time as YYYY-MM-DD.
export function dayOf(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The time with its offset, as ISO 8601 (docs/spec/notifications.md#notices).
export function isoWithOffset(ms) {
  const date = new Date(ms);
  const pad = (n, width = 2) => String(Math.abs(n)).padStart(width, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  return `${local}${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

/**
 * Creates the store. settings(key) returns the current value of a common setting, view supplies setTimeout and clearTimeout, and log(level, line)
 * writes one application log line: level is error or info. onChange is called after each change of the state. now() returns the time of the
 * page in milliseconds; the timers of the notices are counted from it, so a test gives the page clock of its own.
 */
export function createNotices({ settings, view, log, onChange = () => {}, now = () => Date.now() }) {
  const notices = [];
  const origins = new Map();
  let seq = 0;
  let open = false;
  let filter = "all";
  let focusedCard = null;

  const changed = () => onChange();

  // A slot is the visibility of a notice in one place. remaining is the time left when the slot is not running, and null when the slot has no
  // timer. A slot runs while its notice holds no pointer or focus.
  const slotTimerStart = (notice, place) => {
    const slot = notice[place];
    if (!slot || slot.remaining === null || notice.holds > 0 || slot.timer !== null) return;
    slot.startedAt = now();
    slot.timer = view.setTimeout(() => expire(notice, place), slot.remaining);
  };
  const slotTimerStop = (notice, place) => {
    const slot = notice[place];
    if (!slot || slot.timer === null) return;
    view.clearTimeout(slot.timer);
    slot.timer = null;
    slot.remaining = Math.max(0, slot.remaining - (now() - slot.startedAt));
    slot.startedAt = null;
  };
  const remainingOf = (slot) => {
    if (!slot || slot.remaining === null) return null;
    return slot.timer === null ? slot.remaining : Math.max(0, slot.remaining - (now() - slot.startedAt));
  };
  const slotFor = (notice, place, ms) => {
    if (notice[place]) slotTimerStop(notice, place);
    notice[place] = { remaining: ms, startedAt: null, timer: null };
    slotTimerStart(notice, place);
  };
  const clearSlot = (notice, place) => {
    if (!notice[place]) return false;
    slotTimerStop(notice, place);
    notice[place] = null;
    return true;
  };

  // Durations of the places (docs/spec/notifications.md#places). A problem toast closes after the delay only while the setting asks for it.
  const toastMs = (kind) => {
    if (kind === "success" || kind === "info") return TOAST_MS;
    if (kind === "warning" || kind === "error") return settings("autoDismissProblemToasts") ? settings("problemToastDismissSeconds") * 1000 : null;
    return null;
  };
  const lineMs = (kind) => (kind === "success" || kind === "info" ? LINE_MS : null);

  // Whether a new notice of this kind and source shows as a toast (docs/spec/notifications.md#toasts).
  const wantsToast = (kind, source) => {
    if (open) return false;
    if (settings("quietToasts") && kind !== "error") return false;
    if (source.kind !== "card") return true;
    // A card notice shows as a toast only while its card does not have the focus, and only for a warning or an error.
    return source.card !== focusedCard && (kind === "warning" || kind === "error");
  };

  function expire(notice, place) {
    if (notice[place]) notice[place] = null;
    changed();
  }

  // Withdraws a notice from its places: the entry stays and is marked read.
  function withdraw(notice) {
    const had = clearSlot(notice, "toast") | clearSlot(notice, "line");
    notice.read = true;
    return had;
  }

  function remove(notice) {
    withdraw(notice);
    notices.splice(notices.indexOf(notice), 1);
    for (const origin of notice.owners) if (origins.get(origin) === notice) origins.delete(origin);
    notice.owners.clear();
  }

  // Lets an origin own the notice it shows, and releases the origin from the notice it owned before (an origin shows one notice at a time).
  function own(origin, notice) {
    const prior = origins.get(origin);
    if (prior && prior !== notice) {
      prior.owners.delete(origin);
      if (prior.owners.size === 0) withdraw(prior);
    }
    origins.set(origin, notice);
    notice.owners.add(origin);
  }

  const titleOf = (notice) => (notice.count > 1 ? `${notice.base} ×${notice.count}` : notice.base);
  const where = (source) => {
    if (source.kind === "card") return `card ${source.card}`;
    if (source.kind === "plugin") return `plugin ${source.plugin}`;
    if (source.kind === "settings") return "settings";
    return "workbench";
  };
  const logOccurrence = (notice, detail, logPlace = where(notice.source), message = notice.text) => {
    if (notice.kind === "error") log("error", `${logPlace}: ${message}${detail}`);
    else log("info", `notice ${notice.kind}: ${logPlace}: ${titleOf(notice)}`);
  };

  function validate({ kind, title, text, source, actions, progress }) {
    if (!KINDS.includes(kind)) throw new TypeError(`a notice kind must be one of ${KINDS.join(", ")}`);
    if (typeof title !== "string" || title.length < 1 || title.length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(title)) {
      throw new TypeError("a notice title must be 1 to 120 characters without control characters");
    }
    if (typeof text !== "string" || text.length > 1024 || /[\u0000-\u001f\u007f-\u009f]/.test(text)) {
      throw new TypeError("a notice text must be 0 to 1024 characters without control characters");
    }
    if (!SOURCE_KINDS.includes(source.kind)) throw new TypeError(`a notice source kind must be one of ${SOURCE_KINDS.join(", ")}`);
    if (!Array.isArray(actions) || actions.length > 2) throw new TypeError("a notice takes up to two actions");
    if (kind === "progress") {
      if (progress !== null && !(typeof progress === "number" && progress >= 0 && progress <= 1)) {
        throw new TypeError("a progress notice needs a progress from 0 to 1, or null");
      }
    } else if (progress !== undefined) {
      throw new TypeError(`a ${kind} notice takes no progress`);
    }
  }

  /**
   * Shows one occurrence. A shown notice of the same kind and title takes the occurrence (merged), and otherwise a notice is created.
   * An occurrence with an origin replaces the notice of that origin; a redraw of the same text leaves a closed notice closed. Returns the notice id,
   * or the id of the redrawn notice when nothing changed.
   */
  function occur({ kind, title, text = "", source = { kind: "core" }, actions = [], progress, origin = null, detail = "", where: place = null, logText = null }) {
    const fields = { kind, title, text, source, actions, progress };
    validate(fields);
    const logPlace = place ?? where(source);
    const message = logText ?? (text === "" ? title : `${title}\n${text}`);
    if (origin !== null) {
      const prior = origins.get(origin);
      if (prior && prior.kind === kind && prior.base === title && prior.message === message) return prior.id;
    }
    const shown = kind === "progress" ? null : notices.find((n) => n.kind === kind && n.base === title && (n.toast !== null || n.line !== null));
    // A redraw of a shown notice with the same message and no origin is the same occurrence: it adds no count and writes no log line.
    if (shown && origin === null && shown.message === message) return shown.id;
    if (shown) {
      // The shown notice of the same origin is the same occurrence with new content: it adds no count (docs/spec/notifications.md#notices).
      const sameOccurrence = origin !== null && shown === origins.get(origin);
      Object.assign(shown, { text, source, actions, at: now(), read: false, message: logText ?? (text === "" ? title : `${title}\n${text}`) });
      if (!sameOccurrence) shown.count += 1;
      if (origin !== null) own(origin, shown);
      if (shown.toast !== null) slotFor(shown, "toast", toastMs(kind));
      if (shown.line !== null) slotFor(shown, "line", lineMs(kind));
      logOccurrence(shown, detail, logPlace, logText ?? text);
      changed();
      return shown.id;
    }
    const notice = {
      id: `notice-${++seq}`, seq, kind, base: title, text, message: logText ?? (text === "" ? title : `${title}\n${text}`), source, actions, progress: progress ?? null,
      at: now(), count: 1, read: false, origin, holds: 0, toast: null, line: null, owners: new Set(),
    };
    if (origin !== null) own(origin, notice);
    notices.push(notice);
    if (wantsToast(kind, source)) slotFor(notice, "toast", toastMs(kind));
    if (source.kind === "card") slotFor(notice, "line", lineMs(kind));
    logOccurrence(notice, detail, logPlace, logText ?? text);
    changed();
    return notice.id;
  }

  const byId = (id) => {
    const notice = notices.find((n) => n.id === id);
    if (!notice) throw new Error(`notice ${id} is not in the center`);
    return notice;
  };

  // Removes the expired entries of a kind other than error (docs/spec/notifications.md#notice-center).
  function expireEntries() {
    const limit = now() - CENTER_MS;
    let removed = false;
    for (const notice of [...notices]) {
      if (notice.kind === "error" || notice.kind === "progress" || notice.at >= limit) continue;
      remove(notice);
      removed = true;
    }
    return removed;
  }

  const shown = (notice) => notice.toast !== null || notice.line !== null;

  const store = {
    /** Shows a notice that the workbench or a tab creates; returns its id. */
    show: occur,

    /** Shows a notice of a tab, checked with the notice rule of the plugin api, and returns its id. */
    showTab(fields, { card, tab, plugin }) {
      const checked = checkNotice(fields);
      const action = checked.action ? [checked.action] : [];
      return occur({ kind: checked.kind, title: checked.title, text: checked.text, source: { kind: "card", card, tab, plugin }, actions: action,
        progress: checked.kind === "progress" ? null : undefined });
    },

    /** Sets the progress of a progress notice. */
    progress(id, value) {
      const notice = byId(id);
      if (notice.kind !== "progress") throw new Error(`notice ${id} is not a progress notice`);
      notice.progress = value;
      changed();
    },

    /** Ends a progress notice as success or error. */
    done(id, kind, title) {
      const notice = byId(id);
      if (notice.kind !== "progress") throw new Error(`notice ${id} is not a progress notice`);
      Object.assign(notice, { kind, base: title, at: now(), progress: null });
      if (notice.toast !== null) slotFor(notice, "toast", toastMs(kind));
      if (notice.line !== null) slotFor(notice, "line", lineMs(kind));
      logOccurrence(notice, "");
      changed();
    },

    /** Closes the toast and the status line of a notice and keeps its entry. */
    close(id) {
      const notice = notices.find((n) => n.id === id && shown(n));
      if (!notice) throw new RangeError(`notice ${id} is not shown`);
      clearSlot(notice, "toast");
      clearSlot(notice, "line");
      changed();
    },

    /** The text of the notice of an origin, closed or not, until the origin is withdrawn; null when it has none. */
    textOf(origin) {
      return origins.get(origin)?.message ?? null;
    },

    /** The message of the newest shown toast, or null. */
    newestMessage() {
      const toast = notices.filter((n) => n.toast !== null).sort((a, b) => b.seq - a.seq)[0];
      return toast?.message ?? null;
    },

    /** Closes the shown toast whose message is text; false when no shown toast has it. */
    closeMessage(text) {
      const notice = notices.find((n) => n.toast !== null && n.message === text);
      if (!notice) return false;
      clearSlot(notice, "toast");
      changed();
      return true;
    },

    /** Withdraws the notice of an origin when its origin changed or recovered. */
    withdrawOrigin(origin) {
      const notice = origins.get(origin);
      if (!notice) return false;
      origins.delete(origin);
      notice.owners.delete(origin);
      // A notice that another origin still owns stays shown; it is withdrawn when its last owner recovers.
      const had = notice.owners.size === 0 ? withdraw(notice) : false;
      changed();
      return had;
    },

    /** Withdraws every notice of a card or of a tab of a card, as when the tab closes. */
    withdrawTab(tab) {
      let any = false;
      for (const notice of notices) if (notice.source.kind === "card" && notice.source.tab === tab) any = withdraw(notice) || any;
      if (any) changed();
    },

    /** Records the card that has the focus: its notices are read and no toast shows for its information notices. */
    focusCard(card) {
      focusedCard = card;
      let any = false;
      for (const notice of notices) {
        if (notice.source.kind === "card" && notice.source.card === card && !notice.read) { notice.read = true; any = true; }
      }
      if (any) changed();
    },

    /** Holds the timers of a notice while the pointer or the keyboard focus is on it. */
    hold(id, on) {
      const notice = notices.find((n) => n.id === id);
      if (!notice) return;
      if (on) {
        notice.holds += 1;
        slotTimerStop(notice, "toast");
        slotTimerStop(notice, "line");
      } else {
        notice.holds = Math.max(0, notice.holds - 1);
        if (notice.holds === 0) { slotTimerStart(notice, "toast"); slotTimerStart(notice, "line"); }
      }
    },

    /** Applies the settings of the problem toasts: their delay is restarted, or they stay open when the switch is off. The shown toasts keep
     * their list and fields, so no watcher is notified; the new remaining time is read by the status and the view. */
    settingsChanged() {
      for (const notice of notices) {
        if (notice.toast === null || (notice.kind !== "warning" && notice.kind !== "error")) continue;
        slotFor(notice, "toast", toastMs(notice.kind));
      }
    },

    /** Opens or closes the center. */
    toggle() {
      open = !open;
      if (open) expireEntries();
      changed();
    },

    /** Sets the filter of the center. */
    setFilter(next) {
      if (!FILTERS.includes(next)) throw new RangeError(`filter ${String(next)} is not one of ${FILTERS.join(", ")}`);
      filter = next;
      changed();
    },

    /** Marks every entry read. */
    readAll() {
      for (const notice of notices) notice.read = true;
      changed();
    },

    /** Marks one entry read; an id that no entry has is refused (docs/spec/notifications.md#commands-and-statuses). */
    read(id) {
      const notice = notices.find((n) => n.id === id);
      if (!notice) throw new RangeError(`notice ${String(id)} is not an entry`);
      if (notice.read) return;
      notice.read = true;
      changed();
    },

    /** The entries that notices.json holds: the entries without progress, after the expired ones are dropped (docs/spec/notifications.md#notice-center). */
    persistable() {
      expireEntries();
      return notices.filter((n) => n.kind !== "progress").map((n) => ({
        id: n.id, kind: n.kind, title: n.base, text: n.text, source: n.source, actions: n.actions,
        at: isoWithOffset(n.at), count: n.count, read: n.read,
      }));
    },

    /** Restores the entries that notices.json held at start; each gets an id of this session and the expired ones are dropped. */
    restore(entries) {
      for (const entry of entries) {
        const at = Date.parse(entry.at);
        if (Number.isNaN(at)) throw new TypeError(`notice ${String(entry.id)} has no valid time`);
        notices.push({
          id: `notice-${++seq}`, seq, kind: entry.kind, base: entry.title, text: entry.text, message: entry.text === "" ? entry.title : `${entry.title}\n${entry.text}`,
          source: entry.source, actions: entry.actions, progress: null, at, count: entry.count, read: entry.read, origin: null, holds: 0,
          toast: null, line: null, owners: new Set(),
        });
      }
      expireEntries();
      changed();
    },

    /** Removes the entries of one group of the center. The progress group has no clear control. */
    clear(group) {
      if (typeof group !== "string" || !(GROUP_PATTERN.test(group))) throw new RangeError(`group ${String(group)} is not today, yesterday or a day`);
      for (const notice of [...notices]) {
        if (notice.kind === "progress") continue;
        if (groupOf(notice, now()) === group) remove(notice);
      }
      changed();
    },

    /** Removes every entry of the center except the progress entries, which end with their work. */
    clearAll() {
      for (const notice of [...notices]) if (notice.kind !== "progress") remove(notice);
      changed();
    },

    /** The notice of the status line of a card: the newest shown notice of any tab of the card, or null. */
    lineOf(card) {
      let found = null;
      for (const notice of notices) {
        if (notice.line !== null && notice.source.kind === "card" && notice.source.card === card && (found === null || notice.seq > found.seq)) found = notice;
      }
      return found;
    },

    /** The shown toasts in order, newest first, for core.toasts. */
    toasts() {
      return notices.filter((n) => n.toast !== null).sort((a, b) => b.seq - a.seq).map((n) => ({
        id: n.id, kind: n.kind, title: titleOf(n), count: n.count, remaining: n.kind === "progress" ? null : remainingOf(n.toast),
      }));
    },

    /** The notices that the views draw, the newest first, as the entries of the center. */
    entries() {
      expireEntries();
      return notices.map((n) => ({
        id: n.id, kind: n.kind, title: titleOf(n), text: n.text, source: n.source, actions: n.actions,
        at: isoWithOffset(n.at), count: n.count, read: n.read, group: groupOf(n, now()), seq: n.seq,
        ...(n.kind === "progress" ? { progress: n.progress } : {}),
      })).sort((a, b) => b.seq - a.seq);
    },

    /** The state of core.notices. */
    status() {
      const entries = store.entries();
      const unread = entries.filter((e) => !e.read);
      return {
        open, style: settings("noticeCenterStyle"), filter, unread: unread.length,
        problems: unread.some((e) => e.kind === "warning" || e.kind === "error"),
        entries: entries.map(({ group: _group, seq: _seq, ...entry }) => entry),
      };
    },

    /** Whether the center is open, and its filter. */
    get state() { return { open, filter }; },
    /** Each notice record, for the views that draw the entries with their group. */
    records() { return notices.slice(); },
    /** The notice by id, or null. */
    notice(id) { return notices.find((n) => n.id === id) ?? null; },
  };
  return store;
}

// The group of an entry: progress while the notice is in progress, otherwise today, yesterday or its day.
function groupOf(notice, now) {
  if (notice.kind === "progress") return "progress";
  const today = dayOf(now);
  const yesterday = dayOf(now - 24 * 60 * 60 * 1000);
  const day = dayOf(notice.at);
  if (day === today) return "today";
  if (day === yesterday) return "yesterday";
  return day;
}

