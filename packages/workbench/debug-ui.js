// The debug view (docs/spec/debug.md).
//
// A [data-native-modal] dialog like the settings modal: the host draws a copy of this element, so listeners on its
// controls do not run there. Every control has data-key and points to its command with data-command, and answer()
// runs the command of the control that answered.
import { standIn } from "./compositor.js";
import { debug, native, overlay } from "./host.js";
import { icon } from "./icons.js";
import { commandOf, delegate, mark, run } from "./commands.js";
import { registry } from "./exposure.js";
import { hideError, showError } from "./shown-errors.js";
import { newestFirst } from "./debug-order.js";
import { restoreScroll, scrollPositions } from "./scroll-keep.js";

/** The name of the view: its visible title and the name the host gives its window. */
const NAME = "디버그";

/* The elements exist only while the view is open. */
let scrim = null;
let card = null;
let list = null;
let error = null;
let view = null;
let text = null;
let image = null;

/** The path of the state file that opening wrote, or null. */
let recorded = null;
/** The listed files of logs/. */
let entries = [];
/** The file that the view shows, {path, size, truncated}, or null while the list is shown. */
let viewing = null;
/** The running or last operation {action, path, state}, or null. */
let operation = null;
/** The error of the last failed step or operation, or null. */
let failure = null;
/** The scroll position of the shown content in points that the native modal reported. */
let paneScroll = 0;

/* Called when the view draws or closes. The exposure module registers it. */
let drawn = () => {};

/** Registers the function called when the view draws or closes. */
export function onDebugDrawn(fn) {
  drawn = fn;
}

/** The status core.debug. */
export function debugState() {
  return { open: card !== null, recorded, entries, viewing, scroll: debugScroll(), operation, error: failure };
}

/** A size in bytes as text. */
function sizeText(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** A modification time in milliseconds since the epoch as local text. */
const timeText = (modified) => new Date(modified).toLocaleString();

function button(key, name, label, command, params) {
  const el = document.createElement("button");
  el.className = "ui-button";
  el.type = "button";
  el.dataset.key = key;
  el.dataset.expose = name;
  mark(el, command, params);
  el.textContent = label;
  return el;
}

/** Draws the list and, while the view is open, updates the view of the host. */
function draw() {
  if (!card) return;
  queueMicrotask(() => drawn());
  // The same content keeps its scroll position; another content starts at the top, and the text of a file at its end.
  const positions = scrollPositions(card);
  const pane = card.querySelector(".dbg-card__pane");
  pane.dataset.scrollKey = viewing === null ? "list" : `view:${viewing.path}`;
  if (viewing === null) delete pane.dataset.scrollEnd;
  else pane.dataset.scrollEnd = "";
  list.textContent = "";
  for (const file of entries) {
    const row = document.createElement("div");
    row.className = "dbg-row";
    row.dataset.expose = "core.debug.file";
    const path = document.createElement("span");
    path.className = "dbg-row__path";
    path.textContent = file.path;
    const facts = document.createElement("span");
    facts.className = "dbg-row__facts";
    facts.textContent = `${sizeText(file.size)} · ${timeText(file.modified)}`;
    const acts = document.createElement("span");
    acts.className = "dbg-row__acts";
    acts.append(button(`view:${file.path}`, "core.debug.view", "보기", "core.debug.view", { path: file.path }));
    acts.append(button(`save:${file.path}`, "core.debug.save", "저장", "core.debug.save", { path: file.path }));
    row.append(path, facts, acts);
    list.appendChild(row);
  }
  list.hidden = viewing !== null;
  view.hidden = viewing === null;
  if (viewing !== null) {
    view.querySelector(".dbg-card__path").textContent = `${viewing.path} · ${sizeText(viewing.size)}`;
    view.querySelector(".dbg-card__cut").hidden = !viewing.truncated;
  }
  if (failure === null) hideError(error, "debug");
  else showError(error, "debug", failure);
  overlay.update(card);
  const rect = cardRect();
  if (native) overlay.place(card, rect);
  else standIn(true, rect);
  restoreScroll(card, positions);
}

/** Records a failed step or operation and shows it. */
function fail(step, reason) {
  failure = `${step}: ${reason instanceof Error ? reason.message : String(reason)}`;
}

/** The value of every status that the registry serves, core and surface, by name and surface. */
async function pageStatuses() {
  const reads = [];
  for (const entry of registry.list().status.filter((declared) => declared.registered)) {
    const owners = registry.registrants("status", entry.name);
    for (const surface of owners.length ? owners : [null]) {
      const params = surface === null ? { name: entry.name } : { name: entry.name, surface };
      reads.push(registry.handle({ method: "status.get", params }).then((reply) => ({ name: entry.name, surface, ...reply })));
    }
  }
  return Promise.all(reads);
}

function cardRect() {
  const plane = document.getElementById("plane").getBoundingClientRect();
  const r = card.getBoundingClientRect();
  return { x: r.left - plane.left, y: r.top - plane.top, w: r.width, h: r.height };
}

function makeCard() {
  const el = document.createElement("div");
  el.className = "set-card dbg-card";
  el.id = "debug";
  el.dataset.nativeModal = "dialog";
  el.dataset.expose = "core.debug.card";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", NAME);
  el.innerHTML =
    '<header class="set-card__head">' +
      `<span class="set-card__title">${NAME}</span>` +
      `<button class="act" type="button" data-key="close" data-expose="core.debug.close" data-command="core.debug.close" title="닫는다">${icon("close")}</button>` +
    '</header>' +
    '<div class="dbg-card__pane">' +
      '<p class="set-caption">애플리케이션의 모든 진단 파일이다. 결함을 알릴 때 모두 저장한 파일을 함께 보낸다.</p>' +
      '<div class="set-actions"></div>' +
      '<p class="dbg-card__error" hidden></p>' +
      '<div class="dbg-card__list"></div>' +
      '<div class="dbg-card__view" hidden>' +
        '<div class="dbg-card__bar"><span class="dbg-card__path"></span><span class="dbg-card__cut" hidden>앞부분 생략</span></div>' +
        '<pre class="dbg-card__text" data-expose="core.debug.text"></pre>' +
        '<img class="dbg-card__image" data-expose="core.debug.image" alt="" hidden>' +
      '</div>' +
    '</div>';
  el.querySelector(".set-actions").append(button("save-all", "core.debug.save-all", "모두 저장", "core.debug.save-all", {}));
  el.querySelector(".dbg-card__bar").prepend(button("list", "core.debug.list", "목록", "core.debug.list", {}));
  // Without a host this document's card receives input; a control runs the command that it points to.
  delegate(el);
  return el;
}

/**
 * Handles one answer of the card copy that the host draws: key is the control and value its value. The native modal
 * also reports the scroll position of the shown content, which is state and not a command.
 */
function answer(key, val) {
  if (!card || key === "") return;
  if (key === "scroll") {
    const top = Number(val);
    if (!Number.isFinite(top) || top < 0) throw new Error(`debug scroll position is invalid: ${val}`);
    paneScroll = top;
    drawn();
    return;
  }
  const pressed = card.querySelector(`[data-key="${CSS.escape(key)}"]`);
  const found = pressed ? commandOf(pressed) : null;
  if (!found) throw new Error(`debug control ${key} is not in the card`);
  return run(found.name, found.params);
}

/** The scroll position of the shown content in points. */
export const debugScroll = () => (native ? paneScroll : card ? card.querySelector(".dbg-card__pane").scrollTop : 0);

/**
 * Opens the view: records the state into logs/, then lists the files of logs/. A failed step is shown in the view and
 * the next step still runs.
 */
export async function openDebug() {
  if (!debug) throw new Error("the debug view needs the application host");
  if (card) return;
  scrim = document.createElement("div");
  scrim.className = "set-scrim";
  scrim.dataset.expose = "core.debug.scrim";
  card = makeCard();
  scrim.appendChild(card);
  document.body.appendChild(scrim);
  list = card.querySelector(".dbg-card__list");
  error = card.querySelector(".dbg-card__error");
  view = card.querySelector(".dbg-card__view");
  text = view.querySelector(".dbg-card__text");
  image = view.querySelector(".dbg-card__image");
  viewing = null;
  recorded = null;
  entries = [];
  operation = null;
  failure = null;
  paneScroll = 0;
  const opened = card;
  const rect = cardRect();
  if (native) {
    card.style.visibility = "hidden";
    overlay.show(card, rect, answer);
  } else {
    standIn(true, rect);
  }
  draw();
  try {
    recorded = (await debug.record(await pageStatuses())).path;
  } catch (reason) {
    fail("record", reason);
  }
  try {
    entries = newestFirst(await debug.files());
  } catch (reason) {
    fail("list", reason);
  }
  if (card === opened) draw();
}

/** Closes the view. */
export function closeDebug() {
  if (!card) return;
  queueMicrotask(() => drawn());
  if (native) overlay.hide(card);
  else standIn(false);
  hideError(error, "debug");
  scrim.remove();
  scrim = null;
  card = null;
  list = null;
  error = null;
  view = null;
  text = null;
  image = null;
  viewing = null;
}

/** Shows the content of one text file of logs/ in the view. */
export async function viewDebugFile(path) {
  if (!card) throw new Error("the debug view is not open");
  failure = null;
  try {
    const read = await debug.read({ path });
    text.textContent = read.kind === "text" ? read.text : "";
    text.hidden = read.kind !== "text";
    image.hidden = read.kind !== "image";
    if (read.kind === "image") image.src = read.image;
    else image.removeAttribute("src");
    viewing = { path: read.path, size: read.size, truncated: read.truncated, kind: read.kind, length: read.text.length };
  } catch (reason) {
    fail("view", reason);
    throw reason;
  } finally {
    draw();
  }
}

/** Shows the list of files again. */
export function listDebugFiles() {
  if (!card) throw new Error("the debug view is not open");
  viewing = null;
  text.textContent = "";
  image.removeAttribute("src");
  draw();
}

/** Runs one save operation of the open view and answers the host's {saved}. */
async function saving(action, path, save) {
  if (!card) throw new Error("the debug view is not open");
  operation = { action, path, state: "running" };
  failure = null;
  draw();
  try {
    const saved = await save();
    operation = { action, path, state: "done" };
    return saved;
  } catch (reason) {
    operation = { action, path, state: "failed" };
    fail(action, reason);
    throw reason;
  } finally {
    draw();
  }
}

/** Saves one file of logs/ where the person chooses. */
export const saveDebugFile = (path) => saving("save", path, () => debug.save({ path }));

/** Saves logs/ as one gzip-compressed tar file where the person chooses. */
export const saveDebugFiles = () => saving("save-all", null, () => debug.saveAll());
