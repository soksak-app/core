// The input log of one text field of the input probe: the keys that reach the field in order, the preedit of the input method
// and its range, every commit, the caret, the text that Edit > Copy and Edit > Paste move, the wheel events of its document and
// the counts of the pointer gesture on its document. The view field and the field of
// the document region use the same log, so both report the same shape. The module imports nothing, because a region document
// has no import map (docs/spec/native-surfaces.md#document-regions).

/** The number of entries that each list keeps; the sequence of an entry shows how many came before it. */
const LIMIT = 256;

/** The modifier keys of an event, named as core.surface.input names them. */
const modifiersOf = (event) => [["shift", event.shiftKey], ["alt", event.altKey], ["control", event.ctrlKey], ["command", event.metaKey]]
  .filter(([, held]) => held).map(([name]) => name);

/** The text that a key down types: its key when that is one character and no Control or Command key is held, else empty. */
const keyText = (event) => ([...event.key].length === 1 && !event.ctrlKey && !event.metaKey ? event.key : "");

/** The input types of a commit that is not a composition; a composition commits at compositionend. */
const COMMIT_TYPES = new Set(["insertText", "insertReplacementText"]);

const push = (list, entry) => {
  list.push(entry);
  if (list.length > LIMIT) list.shift();
};

/**
 * Observes element, an input or a textarea of view, and returns {read, subscribe, clear, select, clock}. read() is the current
 * state; subscribe(fn) calls fn(state) after each change and returns its stop. Times are event.timeStamp, milliseconds after
 * documentTimeOriginMs of the document of element.
 */
export function createInputLog(element, view) {
  let sequence = 0;
  let keys = [], commits = [], copies = [], pastes = [], wheels = [];
  let preedit = null;
  // The pointer gesture of the document: presses, moves with the primary button held, releases, and the events whose buttons are
  // not those of the gesture of the document (a button of another gesture).
  let pointer = { downs: 0, drags: 0, ups: 0, foreign: 0 };
  let pressed = false;
  let compositionStart = 0;
  const listeners = new Set();
  const caret = () => ({ start: element.selectionStart, end: element.selectionEnd, direction: element.selectionDirection });
  const focused = () => view.document.hasFocus() && view.document.activeElement === element;
  const read = () => ({
    documentTimeOriginMs: view.performance.timeOrigin,
    focused: focused(),
    value: element.value,
    caret: caret(),
    preedit,
    keys: [...keys],
    commits: [...commits],
    copies: [...copies],
    pastes: [...pastes],
    wheels: [...wheels],
    pointer: { ...pointer },
  });
  const changed = () => {
    const state = read();
    for (const fn of listeners) fn(state);
  };
  const next = () => ++sequence;
  const onKey = (event) => {
    push(keys, {
      sequence: next(), type: event.type, key: event.key, code: event.code, modifiers: modifiersOf(event),
      text: event.type === "keydown" ? keyText(event) : "", composing: event.isComposing || event.keyCode === 229,
      repeat: event.repeat, trusted: event.isTrusted, atMs: event.timeStamp,
    });
    changed();
  };
  const handlers = {
    keydown: onKey,
    keyup: onKey,
    compositionstart: () => {
      compositionStart = Math.min(element.selectionStart, element.selectionEnd);
      preedit = { text: "", start: compositionStart, end: compositionStart };
      changed();
    },
    compositionupdate: (event) => {
      preedit = { text: event.data, start: compositionStart, end: compositionStart + event.data.length };
      changed();
    },
    compositionend: (event) => {
      preedit = null;
      // A composition that ends without text, such as a cancelled one, commits nothing.
      if (event.data !== "") push(commits, { sequence: next(), text: event.data, composed: true, atMs: event.timeStamp });
      changed();
    },
    input: (event) => {
      if (!event.isComposing && COMMIT_TYPES.has(event.inputType)) {
        // default: an insertion without data carries no text.
        push(commits, { sequence: next(), text: event.data ?? "", composed: false, atMs: event.timeStamp });
      }
      changed();
    },
    copy: (event) => {
      push(copies, { sequence: next(), text: element.value.slice(element.selectionStart, element.selectionEnd), atMs: event.timeStamp });
      changed();
    },
    paste: (event) => {
      // default: a paste without clipboard data pastes no text.
      push(pastes, { sequence: next(), text: event.clipboardData?.getData("text/plain") ?? "", atMs: event.timeStamp });
      changed();
    },
    focus: changed,
    blur: changed,
    select: changed,
  };
  for (const [type, handler] of Object.entries(handlers)) element.addEventListener(type, handler);
  const documentHandlers = {
    wheel: (event) => {
      push(wheels, { sequence: next(), deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiersOf(event), atMs: event.timeStamp });
      changed();
    },
    pointerdown: (event) => {
      pressed = true;
      pointer = { ...pointer, downs: pointer.downs + 1, foreign: pointer.foreign + (event.buttons === 1 ? 0 : 1) };
      changed();
    },
    pointermove: (event) => {
      if (pressed && event.buttons === 1) pointer = { ...pointer, drags: pointer.drags + 1 };
      else if (event.buttons !== (pressed ? 1 : 0)) pointer = { ...pointer, foreign: pointer.foreign + 1 };
      changed();
    },
    pointerup: (event) => {
      pressed = false;
      pointer = { ...pointer, ups: pointer.ups + 1, foreign: pointer.foreign + (event.buttons === 0 ? 0 : 1) };
      changed();
    },
  };
  for (const [type, handler] of Object.entries(documentHandlers)) view.document.addEventListener(type, handler, { passive: true });
  // The caret moves without an event of the element, such as by an arrow key or a press, so the selection of the document is followed.
  view.document.addEventListener("selectionchange", changed);
  view.addEventListener("focus", changed);
  view.addEventListener("blur", changed);
  return {
    read,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Empties the lists, the pointer counts and the field. */
    clear() {
      keys = [];
      commits = [];
      copies = [];
      pastes = [];
      wheels = [];
      pointer = { downs: 0, drags: 0, ups: 0, foreign: 0 };
      pressed = false;
      preedit = null;
      element.value = "";
      changed();
    },
    /** Sets the value of the field when value is given and its selection when start is given; end defaults to start. */
    select({ value, start, end }) {
      if (value !== undefined && value !== element.value) element.value = value;
      // default: a selection without end is a caret at start.
      if (start !== undefined) element.setSelectionRange(start, end ?? start);
      changed();
    },
    clock: () => ({ documentTimeOriginMs: view.performance.timeOrigin, sourceNowMs: view.performance.now(), sourceResolutionMs: 1 }),
  };
}
