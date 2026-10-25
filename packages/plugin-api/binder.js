// Connects the UI elements of a document to declared commands.
//
// So that human operation and external requests (CLI, MCP) pass through the same command, a UI element points to the command to run
// with data-command and its handler runs the command. Fixed parameters are written as JSON in data-params. An element
// that enters a value adds that value as the parameter named by data-value
// (default value).
//
// The binder records the connected elements and the delegated roots, so audit finds the operable elements that are not connected to a command
// in the running document. The rules are "User interface" in docs/spec/exposure.md.

/** An operable element. For each such element, audit requires a command and a dom name. */
export const INTERACTIVE = 'button, input, select, textarea, [role="button"], [contenteditable]:not([contenteditable="false"])';

// Actual connections across binders of one document. Weak keys do not retain detached elements or documents.
const documentConnections = new WeakMap();
const documentDelegations = new WeakMap();
const documentListeners = new WeakMap();
const notifyDocument = (document) => {
  for (const listener of documentListeners.get(document) ?? []) listener(); // default: a document with no binding observer has nobody to notify.
};

/** Observes connection changes in one document without changing an individual binder's audit scope. */
export function onDocumentBinding(document, listener) {
  if (!documentListeners.has(document)) documentListeners.set(document, new Set());
  const listeners = documentListeners.get(document);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** All open roots of a document or subtree, discovered again for every audit. */
export function documentRoots(root) {
  const roots = [root];
  for (let i = 0; i < roots.length; i++) {
    for (const element of roots[i].querySelectorAll("*")) if (element.shadowRoot) roots.push(element.shadowRoot);
  }
  return roots;
}

const auditRow = (element, connected) => ({
  tag: element.tagName.toLowerCase(),
  // default: an absent exposure or command is reported as null.
  expose: element.dataset.expose ?? null,
  command: connected ? element.dataset.command ?? null : null, // default: an absent command is reported as null in the audit row.
  // default: an element without an accessible name, title or text has empty text.
  text: (element.getAttribute("aria-label") || element.title || element.textContent || "").trim().slice(0, 40),
});

/** Audits actual connections of all binders in the current document, including its open shadow roots. */
export function auditDocument(root) {
  const connected = (element) => {
    if (documentConnections.get(element)?.size) return true;
    if (!element.dataset.command) return false;
    for (let at = element; at; at = at.parentNode) if (documentDelegations.get(at)?.size) return true;
    return false;
  };
  return documentRoots(root).flatMap((part) => [...part.querySelectorAll(INTERACTIVE)])
    .filter((element) => !connected(element) || !element.dataset.expose)
    .map((element) => auditRow(element, connected(element)));
}

/** The current value of a value input element. A checkbox yields a boolean. */
export const valueOf = (el) => (el.type === "checkbox" ? el.checked : el.value);

/** The command and parameters that the element points to. When value exists, it is added as the value parameter. */
export function commandOf(el, value) {
  const name = el.dataset.command;
  if (!name) return null;
  const params = el.dataset.params ? JSON.parse(el.dataset.params) : {};
  // default: a control without data-value sends its value as the value parameter (docs/spec/exposure.md).
  if (value !== undefined) params[el.dataset.value ?? "value"] = value;
  return { name, params };
}

/**
 * Creates one binder.
 *
 *     run(name, params, el)  runs a command. el is the operated element. Returns a promise
 *     check(name)        throws when the name is not a declared command
 *     changed()          called when the connections change. The audit result may have changed
 */
export function createBinder(run, { check, changed = () => {} }) {
  if (typeof check !== "function") throw new Error("createBinder requires check");
  const bound = new WeakSet();
  const roots = new WeakSet();
  const cleanup = new Set();
  const tracked = new Map();
  const owner = {};
  const track = (element, table) => {
    if (!table.has(element)) table.set(element, new Set());
    table.get(element).add(owner);
    if (!tracked.has(table)) tracked.set(table, new Set());
    tracked.get(table).add(element);
    notifyDocument(element.ownerDocument);
  };

  /** Marks an element with a command. The caller passes an input that a delegated root or the caller handles. */
  function mark(el, name, params, valueName) {
    check(name);
    el.dataset.command = name;
    if (params && Object.keys(params).length) el.dataset.params = JSON.stringify(params);
    else delete el.dataset.params;
    if (valueName) el.dataset.value = valueName;
    return el;
  }

  /**
   * Connects an element to a command. Runs the command when event occurs.
   *
   * When params is a function, it is evaluated with the event at run time. Such an element has no data-params.
   * The command does not run when when(event) is false. When the run fails, failed(error) is
   * called; without failed, the rejection goes to unhandledrejection of the document.
   */
  function bind(el, name, params = {}, { event = "click", stop = false, when, failed } = {}) {
    mark(el, name, typeof params === "function" ? null : params);
    const listener = (e) => {
      if (when && !when(e)) return;
      if (stop) e.stopPropagation();
      const done = run(name, typeof params === "function" ? params(e) : params, el);
      return failed ? Promise.resolve(done).catch(failed) : done;
    };
    el.addEventListener(event, listener);
    cleanup.add(() => el.removeEventListener(event, listener));
    bound.add(el);
    track(el, documentConnections);
    changed();
    return el;
  }

  /**
   * Connects the data-command elements in root by delegation. A press runs on click and a value input runs on change and
   * input (input only for elements with data-live). Elements connected directly with bind do not run.
   */
  function delegate(root, { failed } = {}) {
    const go = (found, el) => {
      const done = run(found.name, found.params, el);
      return failed ? Promise.resolve(done).catch(failed) : done;
    };
    const click = (e) => {
      const el = e.target.closest("[data-command]");
      // A directly connected element runs only with its own event. Running it again by delegation would run the command twice.
      if (!el || !root.contains(el) || bound.has(el) || el.matches("input, select, textarea")) return;
      return go(commandOf(el), el);
    };
    root.addEventListener("click", click);
    cleanup.add(() => root.removeEventListener("click", click));
    for (const type of ["change", "input"]) {
      const listener = (e) => {
        const el = e.target.closest("[data-command]");
        if (!el || !root.contains(el) || bound.has(el) || !el.matches("input, select, textarea")) return;
        if (type === "input" && !("live" in el.dataset)) return;
        return go(commandOf(el, valueOf(el)), el);
      };
      root.addEventListener(type, listener);
      cleanup.add(() => root.removeEventListener(type, listener));
    }
    roots.add(root);
    track(root, documentDelegations);
    changed();
    return root;
  }

  /** Whether the element is connected to a command: connected directly, or pointing to a command inside a delegated root. */
  function connected(el) {
    if (bound.has(el)) return true;
    if (!el.dataset.command) return false;
    // parentElement stops at a ShadowRoot. A surface module is mounted inside a shadow tree,
    // so reaching the delegated root requires following parentNode.
    for (let at = el; at; at = at.parentNode) if (roots.has(at)) return true;
    return false;
  }

  /**
   * The operable elements in root that are not connected to a command or have no dom name.
   * Each element is {tag, expose, command, text}.
   */
  function audit(root) {
    return [...root.querySelectorAll(INTERACTIVE)]
      .filter((el) => !connected(el) || !el.dataset.expose)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        // default: an audit row writes a missing dom name and command as null.
        expose: el.dataset.expose ?? null,
        // default: an audit row writes a missing dom name and command as null.
        command: connected(el) ? el.dataset.command ?? null : null,
        // default: the text that identifies an element is the accessible name, then the title, then the text content; an element with none of the three has empty text.
        text: (el.getAttribute("aria-label") || el.title || el.textContent || "").trim().slice(0, 40),
      }));
  }

  /** Runs a declared command. It is used by user operations that are not element events, such as the result of a continuous gesture or a native action. */
  function runDeclared(name, params = {}) {
    check(name);
    return run(name, params);
  }

  return { mark, bind, delegate, audit, run: runDeclared, dispose() {
    cleanup.forEach((dispose) => dispose());
    cleanup.clear();
    const documents = new Set();
    for (const [table, elements] of tracked) for (const element of elements) {
      table.get(element)?.delete(owner);
      documents.add(element.ownerDocument);
    }
    tracked.clear();
    for (const document of documents) notifyDocument(document);
  } };
}
