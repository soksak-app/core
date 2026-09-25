// 문서의 UI 요소를 선언된 명령에 연결한다.
//
// 사람의 조작과 외부 요청(CLI, MCP)이 같은 명령을 거치도록, UI 요소는 실행할 명령을
// data-command 로 가리키고 그 처리기는 명령을 실행한다. 고정된 매개변수는 data-params 에
// JSON 으로 적는다. 값을 입력하는 요소는 그 값을 data-value 가 가리키는 매개변수
// 이름(기본 value)으로 더한다.
//
// 연결한 요소와 위임한 루트를 기록하므로, audit 가 명령에 연결되지 않은 조작 요소를
// 실행 중인 문서에서 찾는다. docs/spec/exposure.md 의 "User interface" 가 규칙이다.

/** 조작 요소. audit 는 이 요소마다 명령과 dom 이름을 요구한다. */
export const INTERACTIVE = 'button, input, select, textarea, [role="button"], [contenteditable]:not([contenteditable="false"])';

/** 값 입력 요소의 현재 값. 체크박스는 불리언이다. */
export const valueOf = (el) => (el.type === "checkbox" ? el.checked : el.value);

/** 요소가 가리키는 명령과 매개변수. value 가 있으면 값 매개변수로 더한다. */
export function commandOf(el, value) {
  const name = el.dataset.command;
  if (!name) return null;
  const params = el.dataset.params ? JSON.parse(el.dataset.params) : {};
  if (value !== undefined) params[el.dataset.value ?? "value"] = value;
  return { name, params };
}

/**
 * 연결기 하나를 만든다.
 *
 *   run(name, params, el)  명령 실행. el 은 조작한 요소다. promise 를 반환한다
 *   check(name)        선언된 명령이 아니면 예외를 던진다
 *   changed()          연결이 바뀌면 호출된다. audit 결과가 달라졌을 수 있다
 */
export function createBinder(run, { check, changed = () => {} }) {
  if (typeof check !== "function") throw new Error("createBinder requires check");
  const bound = new WeakSet();
  const roots = new WeakSet();
  const cleanup = new Set();

  /** 요소에 명령 표시를 붙인다. 입력은 delegate 한 루트나 부르는 쪽이 전달한다. */
  function mark(el, name, params, valueName) {
    check(name);
    el.dataset.command = name;
    if (params && Object.keys(params).length) el.dataset.params = JSON.stringify(params);
    else delete el.dataset.params;
    if (valueName) el.dataset.value = valueName;
    return el;
  }

  /**
   * 요소를 명령에 연결한다. event 가 발생하면 명령을 실행한다.
   *
   * params 가 함수이면 실행할 때 이벤트로 계산한다. 그런 요소는 data-params 를 갖지
   * 않는다. when(event) 이 거짓이면 실행하지 않는다. 실행이 실패하면 failed(error) 를
   * 호출하고, failed 가 없으면 거절이 문서의 unhandledrejection 으로 간다.
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
   * root 안의 data-command 요소를 위임으로 연결한다. 누름은 click, 값 입력은 change 와
   * input 으로 실행한다(input 은 data-live 가 있는 요소만).
   */
  function delegate(root, { failed } = {}) {
    const go = (found, el) => {
      const done = run(found.name, found.params, el);
      return failed ? Promise.resolve(done).catch(failed) : done;
    };
    const click = (e) => {
      const el = e.target.closest?.("[data-command]");
      if (!el || !root.contains(el) || el.matches("input, select, textarea")) return;
      return go(commandOf(el), el);
    };
    root.addEventListener("click", click);
    cleanup.add(() => root.removeEventListener("click", click));
    for (const type of ["change", "input"]) {
      const listener = (e) => {
        const el = e.target.closest?.("[data-command]");
        if (!el || !root.contains(el) || !el.matches("input, select, textarea")) return;
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

  /** 요소가 명령에 연결되었는가. 직접 연결했거나, 위임한 루트 안에서 명령을 가리킨다. */
  function connected(el) {
    if (bound.has(el)) return true;
    if (!el.dataset.command) return false;
    // parentElement stops at a ShadowRoot. Surface modules are mounted in
    // shadow trees, so follow parentNode to reach the delegated root.
    for (let at = el; at; at = at.parentNode) if (roots.has(at)) return true;
    return false;
  }

  /**
   * root 안에서 명령에 연결되지 않았거나 dom 이름이 없는 조작 요소.
   * 요소마다 {tag, expose, command, text} 다.
   */
  function audit(root) {
    return [...root.querySelectorAll(INTERACTIVE)]
      .filter((el) => !connected(el) || !el.dataset.expose)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        expose: el.dataset.expose ?? null,
        command: connected(el) ? el.dataset.command ?? null : null,
        text: (el.getAttribute("aria-label") || el.title || el.textContent || "").trim().slice(0, 40),
      }));
  }

  /** 선언된 명령을 실행한다. 연속 동작의 결과나 네이티브 동작처럼 요소 이벤트가 아닌 사용자 조작이 쓴다. */
  function runDeclared(name, params = {}) {
    check(name);
    return run(name, params);
  }

  return { mark, bind, delegate, audit, run: runDeclared, dispose() {
    cleanup.forEach((dispose) => dispose());
    cleanup.clear();
  } };
}
