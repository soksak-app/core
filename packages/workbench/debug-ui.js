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
import { CLEAR_FILTER, contextRows, eventLine, filterRows, hostEventFiles, LAYERS, LEVELS, mergeRows, parseAppended, parseEvents, ROW_LIMIT } from "./debug-timeline.js";
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
 * The timeline of the host event files {files, limited, rows, positions, selected, shown, lines, filter, following, appended, cursors},
 * or null while the list or a file is shown. `cursors` maps each file to {next, line, size}: the byte offset after the last whole line
 * read, the number of lines read and the size at the last read. A new timeline has a new `cursors` map, which identifies the timeline
 * to a read that finishes after the timeline was replaced.
 */
let timeline = null;
/** The state file that the view shows {path, state, lines, with, differences}, or null while another content is shown. */
let stateShown = null;
/** The running or last operation {action, path, state}, or null. */
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
  return { sources: timeline.files, limited: timeline.limited, following: timeline.following, appended: timeline.appended, total: timeline.rows.length, shown: timeline.shown.length, lines: timeline.lines.length, selected: timeline.selected.size, warning: SELECTION_WARNING, ...timeline.filter };
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
  timelineView.querySelector(".dbg-card__cut").hidden = timeline.limited.length === 0;
  const follow = timelineView.querySelector('[data-key="timeline-follow"]');
  mark(follow, "core.debug.timeline.follow", { on: !timeline.following });
  follow.textContent = timeline.following ? "따라가기 멈춤" : "따라가기 다시 시작";
  timelineRows.textContent = "";
  for (const { row, match } of timeline.lines) {
    const index = timeline.positions.get(row);
    const selected = timeline.selected.has(row);
    const pick = document.createElement("div");
    pick.className = "dbg-card__pick";
    pick.dataset.selected = String(selected);
    const choose = button(`select:${index}`, "core.debug.timeline.select", selected ? "●" : "○", "core.debug.timeline.select", { row: index, selected: !selected });
    choose.setAttribute("aria-label", selected ? "행 선택 해제" : "행 선택");
    const el = document.createElement("div");
    el.className = "dbg-card__line";
    if (!match) el.dataset.context = "true";
    el.dataset.expose = "core.debug.timeline.row";
    el.textContent = eventLine(row);
    pick.append(choose, el);
    timelineRows.appendChild(pick);
  }
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
        '<div class="dbg-card__bar"><span class="dbg-card__cut" hidden>행 한도에서 읽기를 멈춤</span></div>' +
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
    button("timeline-follow", "core.debug.timeline.follow", "따라가기 멈춤", "core.debug.timeline.follow", { on: false }));
  const text = document.createElement("input");
  text.type = "text";
  text.className = "set-text";
  text.placeholder = "찾을 글자";
  el.querySelector(".dbg-card__filters").append(
    filterSelect("level", "core.debug.timeline.level", "가장 낮은 level", LEVELS),
    filterSelect("layer", "core.debug.timeline.layer", "layer", ["all", ...LAYERS]),
    filterControl(text, "text", "core.debug.timeline.text", "찾을 글자"),
    filterField("event", "core.debug.timeline.event", "event 이름"),
    filterField("surface", "core.debug.timeline.surface", "surface"),
    filterField("session", "core.debug.timeline.session", "session"),
    filterField("cid", "core.debug.timeline.cid", "correlation identifier"),
    filterField("from", "core.debug.timeline.from", "시작 시각 (UTC)"),
    filterField("to", "core.debug.timeline.to", "끝 시각 (UTC)"),
    filterSelect("context", "core.debug.timeline.context", "앞뒤 줄 수", ["0", "1", "2", "3", "5", "10"]));
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

/**
 * Reads the whole lines of one event file from the cursor in ranges (`debugReadRange`) up to the end of the file, or until the
 * rows read reach `room`; each call reads at least one range. Answers the rows, the cursor after them and whether the read
 * stopped at the limit before the end of the file. A line that is not written to its end stays unread: the read ends when a range
 * adds no line. The cursor is not changed, so a read that fails leaves the file as it was.
 */
async function readLines(path, cursor, room) {
  const rows = [];
  let { next, line, size } = cursor;
  for (;;) {
    const read = await debug.readRange({ path, offset: next });
    if (read.path !== path) throw new Error(`${path}: the range read answered ${read.path}`);
    const parsed = line === 0 ? parseEvents(path, read.text) : parseAppended(path, read.text, line + 1);
    rows.push(...parsed);
    line += parsed.length;
    const progress = read.next > next;
    next = read.next;
    size = read.size;
    if (!progress || next >= size) return { rows, cursor: { next, line, size }, limited: false };
    if (rows.length >= room) return { rows, cursor: { next, line, size }, limited: true };
  }
}

/** The timeline with `rows` (in time order) and the positions, the rows that pass its filter and the lines recomputed. */
function withRows(base, rows) {
  return { ...base, rows, positions: new Map(rows.map((row, index) => [row, index])), shown: filterRows(rows, base.filter), lines: contextRows(rows, base.filter) };
}

/** Shows the rows of the event files of the host in `logs/` in time order, read in ranges from the start of each file. */
export async function showDebugTimeline() {
  if (!card) throw new Error("the debug view is not open");
  failure = null;
  try {
    const files = hostEventFiles(entries);
    if (files.length === 0) throw new Error("logs/ has no host event file");
    const cursors = new Map();
    const limited = [];
    const loaded = [];
    let total = 0;
    for (const path of files) {
      const read = await readLines(path, { next: 0, line: 0, size: 0 }, ROW_LIMIT - total);
      cursors.set(path, read.cursor);
      if (read.limited) limited.push(path);
      loaded.push(read.rows);
      total += read.rows.length;
    }
    const filter = { ...CLEAR_FILTER };
    timeline = withRows({ files, limited, selected: new Set(), filter, following: true, appended: 0, cursors }, mergeRows(loaded));
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
}

/* The reads that follow the files, one after another: a notice that arrives during a read waits, so a line is read once. */
let reading = Promise.resolve();

/**
 * Reads the lines that grew in `paths` and merges them into the shown timeline in time order. The rows keep their identity, so the
 * selection stays on the same rows; the filter stays. A read that fails stops following and shows the error; the answer is that
 * error, or null. A read that finishes after the timeline was replaced or stopped is discarded and leaves the cursors, so the next
 * read starts there.
 */
function followGrowth(paths) {
  const run = reading.then(async () => {
    const current = timeline;
    if (card === null || current === null || !current.following) return null;
    try {
      const reads = [];
      let total = current.rows.length;
      for (const path of paths) {
        const read = await readLines(path, current.cursors.get(path), ROW_LIMIT - total);
        reads.push({ path, read });
        total += read.rows.length;
      }
      if (timeline === null || timeline.cursors !== current.cursors || !timeline.following) return null;
      const added = reads.flatMap(({ path, read }) => {
        current.cursors.set(path, read.cursor);
        return read.rows;
      });
      const limited = new Set(timeline.limited);
      for (const { path, read } of reads) {
        if (read.limited) limited.add(path);
        else limited.delete(path);
      }
      const stopped = timeline.files.filter((path) => limited.has(path));
      const limitChanged = stopped.join() !== timeline.limited.join();
      if (added.length > 0) timeline = withRows({ ...timeline, appended: timeline.appended + added.length }, mergeRows([timeline.rows, added]));
      timeline = { ...timeline, limited: stopped };
      // A notice that adds nothing draws nothing: the host calls of a draw are recorded events, and each of them is written.
      if (added.length > 0 || limitChanged) draw();
      return null;
    } catch (reason) {
      if (timeline !== null && timeline.cursors === current.cursors) timeline = { ...timeline, following: false };
      fail("follow", reason);
      draw();
      return reason;
    }
  });
  reading = run;
  return run;
}

/* The host event `debug-log-changed {path, size}` (docs/spec/debug.md#following): reads what grew while the timeline follows. */
if (debug) {
  debug.onChanged(({ path }) => {
    if (timeline === null || !timeline.following || !timeline.cursors.has(path)) return;
    // A failed read is shown by the error display and stops following; the notice has no caller to throw to.
    return followGrowth([path]);
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
    const failed = await followGrowth(timeline.files);
    if (failed !== null) throw failed;
  }
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

/** Sets the filter members of the shown timeline; the members that are not given keep their value. */
export function filterDebugTimeline(change) {
  if (!card) throw new Error("the debug view is not open");
  if (timeline === null) throw new Error("the debug timeline is not shown");
  const unknown = Object.keys(change).filter((name) => !Object.hasOwn(CLEAR_FILTER, name));
  if (unknown.length > 0) throw new Error(`timeline filter has no member ${unknown.join(", ")}`);
  if (Object.keys(change).length === 0) throw new Error(`timeline filter needs ${Object.keys(CLEAR_FILTER).slice(0, -1).join(", ")} or context`);
  const filter = { ...timeline.filter, ...change };
  timeline = { ...timeline, filter, shown: filterRows(timeline.rows, filter), lines: contextRows(timeline.rows, filter) };
  draw();
}

/** Selects or unselects the row at `row` (its position among all rows of the timeline, from 0); the same call again changes nothing. */
export function selectDebugRow(row, selected) {
  if (!card) throw new Error("the debug view is not open");
  if (timeline === null) throw new Error("the debug timeline is not shown");
  if (typeof selected !== "boolean") throw new Error(`timeline selected must be a boolean, found ${JSON.stringify(selected)}`);
  if (!Number.isInteger(row) || row < 0 || row >= timeline.rows.length) throw new Error(`timeline row ${JSON.stringify(row)} is not one of the ${timeline.rows.length} rows`);
  const chosen = timeline.rows[row];
  if (selected) timeline.selected.add(chosen);
  else timeline.selected.delete(chosen);
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

/** Saves the text lines of the selected timeline rows, in timeline order, where the person chooses; the person may cancel. */
export async function saveDebugRows() {
  if (card && timeline === null) throw new Error("the debug timeline is not shown");
  const stamp = new Date().toISOString().replace(/[-:]|\.\d+/g, "");
  const name = `soksak-timeline-${stamp}.txt`;
  return saving("save-rows", name, () => {
    const lines = timeline.rows.filter((row) => timeline.selected.has(row)).map(eventLine);
    if (lines.length === 0) throw new Error("no timeline row is selected");
    return debug.saveText({ name, text: `${lines.join("\n")}\n` });
  });
}
