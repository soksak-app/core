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
import { CHANNELS, CLEAR_FILTER, CONTEXT_ROWS, HOLD_LIMIT, PAGE_ROWS, compareRows, eventLine, isEventFile, keyOf, LAYERS, LEVELS, mergeRows, queryOf, rowId } from "./debug-timeline.js";
import { compareStates, parseState, stateFiles, stateLines } from "./debug-state.js";
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
let timelineView = null;
let timelineRows = null;
let stateBox = null;
let stateTree = null;
let stateDiffs = null;

/** The path of the state file that opening wrote, or null. */
let recorded = null;
/** The listed files of logs/. */
let entries = [];
/** The file that the view shows, {path, size, truncated}, or null while the list is shown. */
let viewing = null;
/**
 * The timeline of the event files {filter, rows, ids, older, tail, following, appended, omitted, selected, token}, or null while the list
 * or a file is shown. `rows` are the rows of the pages that the host answered, in key order, and `ids` holds their identities; `older`
 * says that a row before the first one may exist; `tail` is the greatest `seq` of each process when the newest page was read;
 * `omitted` counts the oldest rows that following left out; `selected` maps the identity of each selected row to the row. `token`
 * identifies the timeline to a read that finishes after the timeline was replaced.
 */
let timeline = null;
/** The state file that the view shows {path, state, lines, with, differences}, or null while another content is shown. */
let stateShown = null;
/** The running or last operation {action, path, state}, with {written, total} for a save of the logs folder, or null. */
let operation = null;
/** The error of the last failed step or operation, or null. */
let failure = null;
/** The scroll position of the shown content in points that the native modal reported; negative while it is pulled past its start. */
let paneScroll = 0;

/* Called when the view draws or closes. The exposure module registers it. */
let drawn = () => {};

/** Registers the function called when the view draws or closes. */
export function onDebugDrawn(fn) {
  drawn = fn;
}

/** The warning beside the save of the selected rows (docs/spec/logging.md#privacy). */
const SELECTION_WARNING = "저장한 파일에는 입력한 글자가 들어 있을 수 있다.";

/** The timeline part of the status core.debug. */
function timelineState() {
  if (timeline === null) return null;
  return {
    following: timeline.following, appended: timeline.appended, held: timeline.rows.length, older: timeline.older, omitted: timeline.omitted,
    context: timeline.context.size, selected: timeline.selected.size, warning: SELECTION_WARNING, ...timeline.filter,
  };
}

/** The state part of the status core.debug. */
function stateStatus() {
  if (stateShown === null) return null;
  return { path: stateShown.path, lines: stateShown.lines.length, with: stateShown.with, differences: stateShown.differences.length };
}

/** The status core.debug. */
export function debugState() {
  return { open: card !== null, recorded, entries, viewing, timeline: timelineState(), state: stateStatus(), scroll: debugScroll(), operation, error: failure };
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
  pane.dataset.scrollKey = viewing !== null ? `view:${viewing.path}` : timeline !== null ? "timeline" : stateShown !== null ? `state:${stateShown.path}` : "list";
  if (viewing === null && timeline === null) delete pane.dataset.scrollEnd;
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
    const isState = stateFiles([file]).length === 1;
    acts.append(isState ? button(`state:${file.path}`, "core.debug.state", "상태", "core.debug.state", { path: file.path }) : document.createElement("span"));
    acts.append(button(`view:${file.path}`, "core.debug.view", "보기", "core.debug.view", { path: file.path }));
    acts.append(button(`save:${file.path}`, "core.debug.save", "저장", "core.debug.save", { path: file.path }));
    row.append(path, facts, acts);
    list.appendChild(row);
  }
  list.hidden = viewing !== null || timeline !== null || stateShown !== null;
  view.hidden = viewing === null;
  timelineView.hidden = timeline === null;
  stateBox.hidden = stateShown === null;
  if (timeline !== null) drawTimeline();
  if (stateShown !== null) drawState();
  if (viewing !== null) {
    view.querySelector(".dbg-card__path").textContent = `${viewing.path} · ${sizeText(viewing.size)}`;
    view.querySelector(".dbg-card__cut").hidden = !viewing.truncated;
  }
  if (failure === null) hideError(error, "debug");
  else showError(error, "debug", failure);
  // A save of the logs folder shows its progress and keeps its button disabled while the host writes.
  const writing = operation?.action === "save-all" && operation.state === "running" && operation.total !== undefined;
  const progress = card.querySelector(".dbg-card__progress");
  progress.hidden = !writing;
  card.querySelector('[data-key="save-all"]').disabled = operation?.action === "save-all" && operation.state === "running";
  if (writing) {
    const bar = progress.querySelector("progress");
    bar.max = Math.max(1, operation.total);
    bar.value = operation.written;
    progress.querySelector(".dbg-card__progress-text").textContent = `${megabytes(operation.written)} / ${megabytes(operation.total)} MB`;
  }
  overlay.update(card);
  const rect = cardRect();
  if (native) overlay.place(card, rect);
  else standIn(true, rect);
  restoreScroll(card, positions);
}

/** Draws the filters and the rows of the timeline. Attributes carry the values because the host draws a copy of the element. */
function drawTimeline() {
  for (const field of timelineView.querySelectorAll("[data-set]")) {
    const value = timeline.filter[field.dataset.set];
    if (field.tagName === "SELECT") {
      for (const option of field.options) {
        if (option.value === value) option.setAttribute("selected", "");
        else option.removeAttribute("selected");
      }
    } else {
      field.setAttribute("value", value);
    }
  }
  const follow = timelineView.querySelector('[data-key="timeline-follow"]');
  mark(follow, "core.debug.timeline.follow", { on: !timeline.following });
  follow.textContent = timeline.following ? "따라가기 멈춤" : "따라가기 다시 시작";
  timelineView.querySelector('[data-key="timeline-older"]').hidden = !timeline.older;
  timelineRows.textContent = "";
  const omittedLabel = timelineView.querySelector('[data-expose="core.debug.timeline.omitted"]');
  omittedLabel.hidden = timeline.omitted === 0;
  omittedLabel.textContent = `앞쪽 ${timeline.omitted}행은 보관하지 않음`;
  timeline.rows.forEach((row, index) => {
    const selected = timeline.selected.has(rowId(row));
    const pick = document.createElement("div");
    pick.className = "dbg-card__pick";
    pick.dataset.selected = String(selected);
    const choose = button(`select:${index}`, "core.debug.timeline.select", selected ? "●" : "○", "core.debug.timeline.select", { row: index, selected: !selected });
    choose.setAttribute("aria-label", selected ? "행 선택 해제" : "행 선택");
    const around = button(`context:${index}`, "core.debug.timeline.context", "주변", "core.debug.timeline.context", { row: index });
    around.setAttribute("aria-label", "행 주변 보기");
    const el = document.createElement("div");
    el.className = "dbg-card__line";
    el.dataset.expose = "core.debug.timeline.row";
    // A row that is only context is indented by two spaces, as `sok debug query` prints it.
    const isContext = timeline.context.has(rowId(row));
    el.dataset.context = String(isContext);
    el.textContent = (isContext ? "  " : "") + eventLine(row.event);
    pick.append(choose, around, el);
    timelineRows.appendChild(pick);
  });
}

/** Draws the tree of the shown state file, the choice of the file to compare with, and the differences. */
function drawState() {
  stateBox.querySelector(".dbg-card__path").textContent = stateShown.path;
  const choice = stateBox.querySelector("select");
  choice.textContent = "";
  for (const [value, label] of [["", "비교 안 함"], ...stateFiles(entries).filter((path) => path !== stateShown.path).map((path) => [path, path])]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    // default: a state view that compares with no other file has no selected comparison file.
    if (value === (stateShown.with ?? "")) option.setAttribute("selected", "");
    choice.appendChild(option);
  }
  stateDiffs.textContent = "";
  for (const { path, a, b } of stateShown.differences) {
    const el = document.createElement("div");
    el.className = "dbg-card__line";
    el.dataset.expose = "core.debug.state.difference";
    // default: a path that exists in only one of the compared files has no value in the other, shown as the Korean text for "none" in parentheses.
    el.textContent = `${path}: ${a ?? "(없음)"} -> ${b ?? "(없음)"}`;
    stateDiffs.appendChild(el);
  }
  stateTree.textContent = "";
  for (const { depth, key, value, size } of stateShown.lines) {
    const el = document.createElement("div");
    el.className = "dbg-card__line";
    el.dataset.expose = "core.debug.state.line";
    el.textContent = `${"  ".repeat(depth)}${key}${value === null ? ` ${size}` : `: ${value}`}`;
    stateTree.appendChild(el);
  }
}

/** A filter control of the timeline: its key is the filter member that it sets. */
function filterControl(el, name, expose, label) {
  el.dataset.set = name;
  el.dataset.expose = expose;
  el.setAttribute("aria-label", label);
  mark(el, "core.debug.timeline.filter", {}, name);
  return el;
}

/** A text field for a filter member of the timeline. */
function filterField(name, expose, label) {
  const el = document.createElement("input");
  el.type = "text";
  el.className = "set-text";
  el.placeholder = label;
  return filterControl(el, name, expose, label);
}

/** A selection box for a filter member of the timeline. */
function filterSelect(name, expose, label, values) {
  const el = document.createElement("select");
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    el.appendChild(option);
  }
  return filterControl(el, name, expose, label);
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
      '<div class="dbg-card__progress" hidden><progress data-expose="core.debug.progress" value="0" max="1"></progress><span class="dbg-card__progress-text"></span></div>' +
      '<p class="dbg-card__error" hidden></p>' +
      '<div class="dbg-card__list"></div>' +
      '<div class="dbg-card__view" hidden>' +
        '<div class="dbg-card__bar"><span class="dbg-card__path"></span><span class="dbg-card__cut" hidden>앞부분 생략</span></div>' +
        '<pre class="dbg-card__text" data-expose="core.debug.text"></pre>' +
        '<img class="dbg-card__image" data-expose="core.debug.image" alt="" hidden>' +
      '</div>' +
      '<div class="dbg-card__state" hidden>' +
        '<div class="dbg-card__bar"><span class="dbg-card__path"></span></div>' +
        '<div class="dbg-card__choice"><select data-key="state-with" data-expose="core.debug.state.with" aria-label="비교할 상태 파일"></select></div>' +
        '<div class="dbg-card__rows" data-expose="core.debug.state.differences"></div>' +
        '<div class="dbg-card__rows" data-expose="core.debug.state.tree"></div>' +
      '</div>' +
      '<div class="dbg-card__timeline" hidden>' +
        '<div class="dbg-card__bar"><span class="dbg-card__cut" data-expose="core.debug.timeline.omitted" hidden></span></div>' +
        '<div class="dbg-card__filters"></div>' +
        '<div class="dbg-card__save"><span class="dbg-card__warning" data-expose="core.debug.timeline.warning"></span></div>' +
        '<div class="dbg-card__rows" data-expose="core.debug.timeline.rows"></div>' +
      '</div>' +
    '</div>';
  el.querySelector(".set-actions").append(
    button("save-all", "core.debug.save-all", "모두 저장", "core.debug.save-all", {}),
    button("timeline", "core.debug.timeline", "타임라인", "core.debug.timeline", {}));
  el.querySelector(".dbg-card__view .dbg-card__bar").prepend(button("list", "core.debug.list", "목록", "core.debug.list", {}));
  mark(el.querySelector(".dbg-card__state select"), "core.debug.state.compare", {}, "with");
  el.querySelector(".dbg-card__state .dbg-card__bar").prepend(button("state-list", "core.debug.state.list", "목록", "core.debug.list", {}));
  el.querySelector(".dbg-card__save").prepend(button("timeline-save", "core.debug.timeline.save", "선택한 행 저장", "core.debug.timeline.save", {}));
  el.querySelector(".dbg-card__warning").textContent = SELECTION_WARNING;
  el.querySelector(".dbg-card__timeline .dbg-card__bar").prepend(
    button("timeline-list", "core.debug.timeline.list", "목록", "core.debug.list", {}),
    button("timeline-follow", "core.debug.timeline.follow", "따라가기 멈춤", "core.debug.timeline.follow", { on: false }),
    button("timeline-older", "core.debug.timeline.older", "이전 행", "core.debug.timeline.older", {}));
  const text = document.createElement("input");
  text.type = "text";
  text.className = "set-text";
  text.placeholder = "찾을 글자";
  el.querySelector(".dbg-card__filters").append(
    filterSelect("channel", "core.debug.timeline.channel", "channel", CHANNELS),
    filterSelect("level", "core.debug.timeline.level", "가장 낮은 level", LEVELS),
    filterSelect("layer", "core.debug.timeline.layer", "layer", ["all", ...LAYERS]),
    filterControl(text, "text", "core.debug.timeline.text", "찾을 글자"),
    filterField("class", "core.debug.timeline.class", "class"),
    filterField("event", "core.debug.timeline.event", "event 이름"),
    filterField("event_prefix", "core.debug.timeline.event-prefix", "event 이름의 앞부분"),
    filterField("surface", "core.debug.timeline.surface", "surface"),
    filterField("session", "core.debug.timeline.session", "session"),
    filterField("cid", "core.debug.timeline.cid", "correlation identifier"),
    filterField("run", "core.debug.timeline.run", "run 식별자"),
    filterField("from", "core.debug.timeline.from", "시작 시각 (UTC)"),
    filterField("to", "core.debug.timeline.to", "끝 시각 (UTC)"));
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
    // A position is a measurement of the native modal: it is negative while the content is pulled past its start, so it is
    // kept as reported. Only a value that is not a finite number is refused.
    const top = typeof val === "string" && val.trim() === "" ? NaN : Number(val);
    if (!Number.isFinite(top)) throw new Error(`debug scroll position is not a number: ${val}`);
    paneScroll = top;
    drawn();
    return;
  }
  const pressed = card.querySelector(`[data-key="${CSS.escape(key)}"]`);
  const field = pressed ? null : card.querySelector(`[data-set="${CSS.escape(key)}"]`);
  const found = pressed ? commandOf(pressed) : field ? commandOf(field, val) : null;
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
  // An image has no height before it loads, so the card measured at the first draw is too low for the native modal. The load of
  // the image places the modal again with the height of the card that holds it; an image that the list replaced is not drawn.
  image.addEventListener("load", () => {
    if (viewing?.kind === "image") draw();
  });
  timelineView = card.querySelector(".dbg-card__timeline");
  timelineRows = timelineView.querySelector(".dbg-card__rows");
  stateBox = card.querySelector(".dbg-card__state");
  [stateDiffs, stateTree] = stateBox.querySelectorAll(".dbg-card__rows");
  viewing = null;
  timeline = null;
  stateShown = null;
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
  timelineView = null;
  timelineRows = null;
  stateBox = null;
  stateTree = null;
  stateDiffs = null;
  viewing = null;
  timeline = null;
  stateShown = null;
}

/** Shows the content of one text file of logs/ in the view. */
export async function viewDebugFile(path) {
  if (!card) throw new Error("the debug view is not open");
  failure = null;
  timeline = null;
  stateShown = null;
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
  timeline = null;
  stateShown = null;
  text.textContent = "";
  image.removeAttribute("src");
  draw();
}

/* The reads and changes of the timeline, one after another: a notice that arrives during a read waits, so a row is read once. */
let reading = Promise.resolve();

/** Runs `task` after the earlier tasks of the timeline; the task's own result or failure is the answer. */
function exclusive(task) {
  const run = reading.then(task);
  // The next task starts when this one ended, whatever its outcome; the outcome itself is the answer that the caller receives.
  reading = Promise.allSettled([run]);
  return run;
}

/** Asks the host for a page of the query. */
async function pageOf(request) {
  const page = await debug.query(request);
  if (page === null || typeof page !== "object" || !Array.isArray(page.rows) || typeof page.tail !== "object") {
    throw new Error(`the host answered a page without rows and a tail: ${JSON.stringify(page)}`);
  }
  return page;
}

/** A timeline of the newest page of a query (in descending order) with the selection and the following that it keeps. */
function freshTimeline(filter, page, selected, following) {
  const rows = page.rows.toReversed();
  return { filter, rows, ids: new Set(rows.map(rowId)), context: new Set(), older: page.next !== null, tail: page.tail, following, appended: 0, omitted: 0, selected, token: {} };
}

/** Shows the newest rows of the event files of the logs folder, one page of the query of the host. */
export function showDebugTimeline() {
  if (!card) throw new Error("the debug view is not open");
  failure = null;
  return exclusive(async () => {
    try {
      const filter = { ...CLEAR_FILTER };
      const page = await pageOf({ ...queryOf(filter), order: "desc", limit: PAGE_ROWS });
      timeline = freshTimeline(filter, page, new Map(), true);
      viewing = null;
      stateShown = null;
      text.textContent = "";
      image.removeAttribute("src");
    } catch (reason) {
      timeline = null;
      fail("timeline", reason);
      throw reason;
    } finally {
      draw();
    }
  });
}

/**
 * Adds the rows that the pages bring to the held rows in key order, once each. When the held rows would pass HOLD_LIMIT, the oldest
 * rows leave the view and are counted in `omitted`. The rows of the context of a row (`asContext`) that were not held are held as
 * context; a row that a page of the filter brings and that was held as context is a row of the filter from then on. Returns the
 * timeline with the rows and the number of rows that were new.
 */
function withPage(current, rows, asContext = false) {
  const fresh = rows.filter((row) => !current.ids.has(rowId(row)));
  let merged = mergeRows(current.rows, fresh);
  const shed = Math.max(0, merged.length - HOLD_LIMIT);
  merged = merged.slice(shed);
  const ids = new Set(merged.map(rowId));
  const brought = new Set(rows.map(rowId));
  const context = new Set([...current.context].filter((id) => ids.has(id) && (asContext || !brought.has(id))));
  if (asContext) for (const row of fresh) if (ids.has(rowId(row))) context.add(rowId(row));
  return { timeline: { ...current, rows: merged, ids, context, omitted: current.omitted + shed, older: current.older || shed > 0 }, fresh: fresh.length };
}

/**
 * Asks for the rows that the files gained after the `tail` of the shown timeline and adds them in key order. The rows keep their
 * identity, so the selection stays; the filter stays. A read that fails stops following and shows the error; the answer is that
 * error, or null. A read that finishes after the timeline was replaced or stopped is discarded and leaves the tail, so the next read
 * starts there.
 */
function followGrowth() {
  return exclusive(async () => {
    const current = timeline;
    if (card === null || current === null || !current.following) return null;
    try {
      const request = { ...queryOf(current.filter), order: "asc", limit: PAGE_ROWS, since: current.tail };
      let next = { ...current };
      let tail = null;
      let appended = 0;
      for (let after; ;) {
        const page = await pageOf(after === undefined ? request : { ...request, after });
        // The tail of the first page is the tail of the whole read: a row that the later pages hold and that arrived after it is read again.
        // default: the first page of a read sets the tail of the whole read; later pages keep it.
        tail ??= page.tail;
        const added = withPage(next, page.rows);
        next = added.timeline;
        appended += added.fresh;
        if (page.next === null) break;
        after = page.next;
      }
      if (timeline === null || timeline.token !== current.token || !timeline.following) return null;
      const unmarked = next.context.size !== timeline.context.size;
      timeline = { ...timeline, rows: next.rows, ids: next.ids, context: next.context, omitted: next.omitted, older: next.older, tail, appended: timeline.appended + appended };
      // A notice that adds nothing and ends no context draws nothing: the host calls of a draw are recorded events, and each of them is written.
      if (appended > 0 || unmarked) draw();
      return null;
    } catch (reason) {
      if (timeline !== null && timeline.token === current.token) timeline = { ...timeline, following: false };
      fail("follow", reason);
      draw();
      return reason;
    }
  });
}

/* The host events of a save of the logs folder (docs/spec/debug.md): the host writes one save at a time, so a page that was
   reloaded while a save writes takes the save of the events as its operation. */
if (debug) {
  debug.onSaveProgress(({ saved, written, total }) => {
    operation = { action: "save-all", path: saved, state: "running", written, total };
    draw();
  });
  debug.onSaveDone(({ saved, error: reason }) => {
    // default: a page that did not see the start of the save knows no total and shows the save as ended.
    const total = operation?.path === saved ? operation.total ?? 0 : 0;
    // default: a failed write keeps the bytes that the last progress reported.
    const written = reason === null ? total : operation?.path === saved ? operation.written ?? 0 : 0;
    operation = { action: "save-all", path: saved, state: reason === null ? "done" : "failed", written, total };
    if (reason !== null) fail("save-all", reason);
    draw();
  });
}

/* The host event `debug-log-changed {path, size, notices, coalesced}` (docs/spec/debug.md#following): asks for what grew while the timeline follows. The host bounds the rate of the notices. */
if (debug) {
  debug.onChanged(({ path }) => {
    if (timeline === null || !timeline.following || !isEventFile(path)) return;
    // A failed read is shown by the error display and stops following; the notice has no caller to throw to.
    return followGrowth();
  });
}

/** Stops or resumes following the files; resuming first reads what grew while stopped. The same call again changes nothing. */
export async function followDebugTimeline(on) {
  if (!card) throw new Error("the debug view is not open");
  if (timeline === null) throw new Error("the debug timeline is not shown");
  if (typeof on !== "boolean") throw new Error(`timeline follow must be a boolean, found ${JSON.stringify(on)}`);
  failure = null;
  timeline = { ...timeline, following: on };
  draw();
  if (on) {
    const failed = await followGrowth();
    if (failed !== null) throw failed;
  }
}

/** Asks for the page of rows before the oldest held row and puts it in front of them. */
export function olderDebugTimeline() {
  if (!card) throw new Error("the debug view is not open");
  if (timeline === null) throw new Error("the debug timeline is not shown");
  failure = null;
  return exclusive(async () => {
    const current = timeline;
    if (current === null || !current.older || current.rows.length === 0) return;
    try {
      if (current.rows.length >= HOLD_LIMIT) throw new Error(`the timeline holds ${HOLD_LIMIT} rows; narrow the filter or the time`);
      const limit = Math.min(PAGE_ROWS, HOLD_LIMIT - current.rows.length);
      const page = await pageOf({ ...queryOf(current.filter), order: "desc", limit, after: keyOf(current.rows[0]) });
      if (timeline === null || timeline.token !== current.token) return;
      const added = withPage(timeline, page.rows);
      timeline = { ...added.timeline, older: page.next !== null || added.timeline.omitted > timeline.omitted };
    } catch (reason) {
      fail("older", reason);
      throw reason;
    } finally {
      draw();
    }
  });
}

/** Reads and parses one listed state file. */
async function readState(path) {
  if (!stateFiles(entries).includes(path)) throw new Error(`${path} is not a state file of the list`);
  const read = await debug.read({ path });
  if (read.kind !== "text") throw new Error(`${path}: a state file must be text, found ${read.kind}`);
  return parseState(path, read.text, read.truncated);
}

/** Shows one state file of logs/ as a tree. */
export async function showDebugState(path) {
  if (!card) throw new Error("the debug view is not open");
  failure = null;
  try {
    const state = await readState(path);
    stateShown = { path, state, lines: stateLines(state), with: null, differences: [] };
    viewing = null;
    timeline = null;
    text.textContent = "";
    image.removeAttribute("src");
  } catch (reason) {
    fail("state", reason);
    throw reason;
  } finally {
    draw();
  }
}

/** Compares the shown state file with another state file of the list; an empty path ends the comparison. */
export async function compareDebugState(path) {
  if (!card) throw new Error("the debug view is not open");
  if (stateShown === null) throw new Error("the debug state is not shown");
  failure = null;
  try {
    if (path === "") {
      stateShown = { ...stateShown, with: null, differences: [] };
      return;
    }
    if (path === stateShown.path) throw new Error(`${path} is the shown state file`);
    const other = await readState(path);
    stateShown = { ...stateShown, with: path, differences: compareStates(stateShown.state, other) };
  } catch (reason) {
    fail("compare", reason);
    throw reason;
  } finally {
    draw();
  }
}

/** Sets the filter members of the shown timeline and asks for its newest page again; the members that are not given keep their value. */
export function filterDebugTimeline(change) {
  if (!card) throw new Error("the debug view is not open");
  if (timeline === null) throw new Error("the debug timeline is not shown");
  const unknown = Object.keys(change).filter((name) => !Object.hasOwn(CLEAR_FILTER, name));
  if (unknown.length > 0) throw new Error(`timeline filter has no member ${unknown.join(", ")}`);
  if (Object.keys(change).length === 0) throw new Error(`timeline filter needs ${Object.keys(CLEAR_FILTER).join(", ")}`);
  failure = null;
  return exclusive(async () => {
    try {
      const filter = { ...timeline.filter, ...change };
      const page = await pageOf({ ...queryOf(filter), order: "desc", limit: PAGE_ROWS });
      timeline = freshTimeline(filter, page, timeline.selected, timeline.following);
    } catch (reason) {
      fail("filter", reason);
      throw reason;
    } finally {
      draw();
    }
  });
}

/** Selects or unselects the row at `row` (its position among the held rows, from 0); the same call again changes nothing. */
export function selectDebugRow(row, selected) {
  if (!card) throw new Error("the debug view is not open");
  if (timeline === null) throw new Error("the debug timeline is not shown");
  if (typeof selected !== "boolean") throw new Error(`timeline selected must be a boolean, found ${JSON.stringify(selected)}`);
  if (!Number.isInteger(row) || row < 0 || row >= timeline.rows.length) throw new Error(`timeline row ${JSON.stringify(row)} is not one of the ${timeline.rows.length} rows`);
  const chosen = timeline.rows[row];
  if (selected) timeline.selected.set(rowId(chosen), chosen);
  else timeline.selected.delete(rowId(chosen));
  draw();
}

/**
 * Brings the rows around the row at `row` (its position among the held rows, from 0) into the held rows: the `CONTEXT_ROWS` rows
 * before it and the `CONTEXT_ROWS` rows after it in the channel of the filter, whatever the other members of the filter are. The rows
 * that were not held are shown as context. A new filter or a new timeline shows its own rows only.
 */
export async function contextDebugRow(row) {
  if (!card) throw new Error("the debug view is not open");
  if (timeline === null) throw new Error("the debug timeline is not shown");
  if (!Number.isInteger(row) || row < 0 || row >= timeline.rows.length) throw new Error(`timeline row ${JSON.stringify(row)} is not one of the ${timeline.rows.length} rows`);
  failure = null;
  const chosen = timeline.rows[row];
  return exclusive(async () => {
    const current = timeline;
    if (current === null) return;
    try {
      const page = await pageOf({ channel: current.filter.channel, around: keyOf(chosen), earlier: CONTEXT_ROWS, later: CONTEXT_ROWS });
      if (timeline === null || timeline.token !== current.token) return;
      timeline = withPage(timeline, page.rows, true).timeline;
    } catch (reason) {
      fail("context", reason);
      throw reason;
    } finally {
      draw();
    }
  });
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

/** The number of bytes in MB with one decimal. */
const megabytes = (bytes) => (bytes / (1024 * 1024)).toFixed(1);

/**
 * Saves logs/ as one gzip-compressed tar file where the person chooses. The host answers {saved, total} when the place is
 * chosen and writes on its own thread; the events debug-save-progress and debug-save-done end the operation.
 */
export async function saveDebugFiles() {
  if (!card) throw new Error("the debug view is not open");
  if (operation?.action === "save-all" && operation.state === "running") {
    // default: before the person chose a place the save has no path, and the save panel is what runs.
    const refused = new Error(`debug: a save of the logs folder is running: ${operation.path ?? "the save panel is open"}`);
    fail("save-all", refused);
    draw();
    throw refused;
  }
  operation = { action: "save-all", path: null, state: "running" };
  failure = null;
  draw();
  let started;
  try {
    started = await debug.saveAll();
  } catch (reason) {
    operation = { action: "save-all", path: null, state: "failed" };
    fail("save-all", reason);
    draw();
    throw reason;
  }
  operation = started.saved === null
    ? { action: "save-all", path: null, state: "done" }
    : { action: "save-all", path: started.saved, state: "running", written: 0, total: started.total };
  draw();
  return started;
}

/** Saves the text lines of the selected timeline rows, in timeline order, where the person chooses; the person may cancel. */
export async function saveDebugRows() {
  if (card && timeline === null) throw new Error("the debug timeline is not shown");
  const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, "");
  const name = `soksak-timeline-${stamp}.txt`;
  return saving("save-rows", name, () => {
    const lines = [...timeline.selected.values()].toSorted(compareRows).map((row) => eventLine(row.event));
    if (lines.length === 0) throw new Error("no timeline row is selected");
    return debug.saveText({ name, text: `${lines.join("\n")}\n` });
  });
}
