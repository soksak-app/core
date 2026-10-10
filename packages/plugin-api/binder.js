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
  } };
}
