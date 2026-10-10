// Diagnostic recorder for the observations that a ResizeObserver loop could not deliver within one frame (G1.4-115).
//
// When a ResizeObserver callback changes the size of an element that the observation round of that frame has already passed, WebKit
// defers that observation to the next frame and reports "ResizeObserver loop completed with undelivered notifications." as an error event.
// The deferred observation is delivered in the observation round of the next frame, so after the error this recorder collects the targets and sizes that the callbacks of that frame
// received and sends them with report in the following frame. It also sends the callbacks that ran in the frame of the error and the code that created their observers,
// so the callback that changed the size of an element after its observation round can be found (F32). It runs only in diagnostic builds.
//
// DOM mutations are divided by the callback slot of the observation round (F43). A slot is one callback and the microtask checkpoint after it.
// The records that takeRecords fetches right before the next callback, together with the records delivered to the MutationObserver in between, are the mutations of that slot.
// The error event is sent after the round ends, so the records fetched then are the mutations of the last slot, and the records delivered after that
// until the rAF of the next frame are the mutations after the round.
//
// A mutation record does not name the code that made the mutation. A dataset write on body (such as data-screen of a screen switch) sends the
// stack of the code that wrote it inside the slot as a line of that slot, so the path that changed the screen inside the round can be found by measurement (F43).

/** Location of the code that created the observer: the first line of the stack outside this file. */
function creator() {
  // default: an engine without a stack has no location line, and then the record states that the location is unknown.
  const lines = (new Error().stack ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  // default: if there is no line outside this file, the record states that the location is unknown.
  return lines.find((line) => !line.includes("resize-loop.js") && !/^Error\b/.test(line)) ?? "unknown creator";
}

/** Call stack outside this file, joined with " < " starting from the innermost frame. */
function callStack() {
  // default: an engine without a stack has no location line, so it is read as empty text and the unknown stack is written below.
  const lines = (new Error().stack ?? "").split("\n").map((line) => line.trim())
    .filter((line) => line && !line.includes("resize-loop.js") && !/^Error\b/.test(line));
  // default: an engine without a stack has no location line, and then the record states that the stack is unknown.
  return lines.length ? lines.join(" < ") : "unknown stack";
}

/** Writes the key of the dataset as an attribute name. */
const dataName = (key) => `data-${String(key).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;

/** Writes the observed target so it can be recognized in the log. */
function describe(element) {
  let text = element.tagName.toLowerCase();
  if (element.id) text += `#${element.id}`;
  for (const name of [...element.classList].slice(0, 2)) text += `.${name}`;
  for (const attribute of ["data-expose", "data-surface-id", "data-card-id"]) {
    const value = element.getAttribute(attribute);
    if (value !== null) text += `[${attribute}=${value}]`;
  }
  return text;
}

/** Writes the mutation record so it can be recognized in the log. */
function change(record) {
  const what = record.type === "attributes" ? `attributes ${record.attributeName}` : record.type;
  return `${what} of ${record.target.nodeType === 1 ? describe(record.target) : record.target.nodeName}`;
}

/** Condenses the mutation list into one identical item. */
function changes(list) {
  return list.length ? [...new Set(list)].join(", ") : "nothing";
}

/**
 * Replaces the ResizeObserver of view with a subclass that records, and sends the mutations of each callback slot of the frame with the loop error, the
 * mutations after the round, and the observations delivered in the next frame through report(line). Only observers created after the replacement are recorded. The code that wrote
 * the dataset of body inside a slot is sent as the stack of trace().
 */
export function watchResizeLoop(view, report, locate = creator, trace = callStack) {
  const Native = view.ResizeObserver;
  let collected = null;
  // Mutations not yet delivered at the first callback of this frame. Records delivered before the first callback cannot be
  // distinguished from those of the previous frame, so they are not included.
  let before = [];
  // Callback slots that ran in this frame. The rAF of the next frame clears them, and that rAF runs before the observation round of the next frame.
  let slots = [];
  // Mutations that happened after the loop error until the rAF of the next frame. null if there was no error.
  let after = null;
  let clearing = false;
  /** List that the current record belongs to: after the round if the error occurred, the last slot inside the round, before the round right before the first callback. */
  const current = () => {
    if (after) return after;
    if (clearing) return slots.at(-1).changed;
    return before;
  };
  const mutations = new view.MutationObserver((records) => {
    // Records delivered before the first callback are not included (see before).
    if (!after && !clearing) return;
    const into = current();
    for (const record of records) into.push(change(record));
  });
  mutations.observe(view.document, { subtree: true, childList: true, attributes: true, characterData: true });
  /** Fetches the records not yet delivered as the mutations of the current slot. */
  const take = (into) => {
    for (const record of mutations.takeRecords()) into.push(change(record));
  };
  // Records the code that writes the dataset of body inside a slot. dataset reads and clears the attributes of body directly.
  const body = view.document.body;
  const dataset = body.dataset;
  const write = (what) => {
    if (clearing && !after) slots.at(-1).writes.push(`${what} at ${trace()}`);
  };
  const traced = new Proxy(dataset, {
    set(target, key, value) {
      write(`set ${dataName(key)} of body to ${value}`);
      target[key] = value;
      return true;
    },
    deleteProperty(target, key) {
      write(`removed ${dataName(key)} of body`);
      return delete target[key];
    },
  });
  Object.defineProperty(body, "dataset", { configurable: true, get: () => traced });
  const sized = (entry) => `${describe(entry.target)} ${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
  view.ResizeObserver = class extends Native {
    constructor(callback) {
      // It also records the time when the observer was created. An observer created during the observation round defers part of its first observation to the next frame (F32).
      const label = `${locate()} created at ${view.performance.now().toFixed(1)}ms`;
      super((entries, observer) => {
        if (collected) {
          for (const entry of entries) collected.push(sized(entry));
        }
        // Records before this callback belong to the previous slot, or to the changes before the round if this is the first callback.
        take(current());
        // The time uses the same clock as the layout stages of the performance trace. It matches the callbacks of the frame with the error against the layout draw.
        slots.push({ ran: `${label} at ${view.performance.now().toFixed(1)}ms on ${[...entries].map(sized).join(", ")}`, changed: [], writes: [] });
        if (!clearing) {
          clearing = true;
          view.requestAnimationFrame(() => {
            before = [];
            slots = [];
            clearing = false;
          });
        }
        return callback(entries, observer);
      });
    }
  };
  view.addEventListener("error", (event) => {
    if (!/^ResizeObserver loop/.test(event.message) || collected || after) return;
    // The error event is sent after the round, so the records so far are the mutations of the last slot.
    take(current());
    report(`resize observer loop: before the round, undelivered at the first callback: ${changes(before)}`);
    if (!slots.length) report("resize observer loop: this frame ran no callback");
    slots.forEach((slot, index) => {
      report(`resize observer loop: in the round callback ${index + 1} ran ${slot.ran}, then changed ${changes(slot.changed)}`);
      for (const written of slot.writes) report(`resize observer loop: in the round callback ${index + 1} ${written}`);
    });
    after = [];
    // The rAF of the next frame runs before the observation round of that frame, and the rAF of the frame after it runs after that round.
    view.requestAnimationFrame(() => {
      take(after);
      report(`resize observer loop: after the round changed ${changes(after)}`);
      after = null;
      collected = [];
      view.requestAnimationFrame(() => {
        const lines = collected;
        collected = null;
        report(`resize observer loop: the next frame delivered ${lines.length ? lines.join(", ") : "no observation"}`);
      });
    });
  });
}
