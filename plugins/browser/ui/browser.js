const css = `:host{display:flex;height:100%;flex-direction:column;background:var(--card);color:var(--fg);font:12px/1.4 var(--font)}#bar{display:flex;gap:4px;padding:4px 6px;border-bottom:1px solid var(--rule)}#bar button{display:grid;place-items:center;width:20px;height:20px;padding:0;border:0;border-radius:var(--r-xs);background:transparent;color:var(--muted);cursor:pointer}#bar button:hover:not(:disabled){background:var(--inset);color:var(--fg)}#bar svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.95;stroke-linecap:round;stroke-linejoin:round}#bar{align-items:center}input{flex:1;min-width:0;background:transparent;color:inherit;border:1px solid var(--edge);border-radius:5px;padding:3px 8px}#document,#empty{flex:1;min-height:0}#empty{display:flex;align-items:center;justify-content:center;background:var(--card);color:var(--muted);cursor:text}[hidden]{display:none!important}`;

// 기록 단추는 카드 머리 단추(.chrome__act)와 같은 크기, 색, hover 를 쓴다. 획 폭 1.95 는 24 단위 아이콘을
// 14px 로 그릴 때 카드 머리의 16 단위 획 1.3 과 같은 굵기다.
export async function mount(root, context) {
  if (typeof context.surfaceId !== "string" || context.surfaceId === "") {
    throw new TypeError("browser surface requires a surfaceId for location persistence");
  }
  root.innerHTML = `<style>${css}</style><div id="bar"><button data-command="browser.back" aria-label="뒤로">${context.icon("chevron-left")}</button><button data-command="browser.forward" aria-label="앞으로">${context.icon("chevron-right")}</button><button data-command="browser.reload" aria-label="새로 고침">${context.icon("rotate-cw")}</button><input id="address" data-expose="browser.address" aria-label="주소"></div><div id="document" data-expose="browser.document"></div><div id="empty" data-expose="browser.empty" data-command="browser.address.select">주소를 입력하세요</div>`;
  const address = root.querySelector("#address");
  const area = root.querySelector("#document");
  const empty = root.querySelector("#empty");
  // 주소가 없으면 문서 요소를 숨겨 합성이 문서 영역을 보이지 않게 배치하고, 빈 상태를 그 자리에 둔다.
  const showEmpty = (url) => {
    area.hidden = url === "";
    empty.hidden = url !== "";
  };
  const storageKey = `soksak.browser.location.${context.surfaceId}`;
  const storage = root.ownerDocument.defaultView.localStorage;
  const restored = storage.getItem(storageKey);
  if (restored !== null && !/^https?:\/\/[^/]/i.test(restored)) {
    throw new Error(`stored browser location for ${context.surfaceId} is not an http or https address`);
  }
  // 첫 클릭으로 얻은 전체 선택은 뗄 때까지 유지하고 이후 클릭은 캐럿 이동을 허용한다.
  let selecting = false;
  const beginSelection = () => { selecting = root.activeElement !== address; };
  const retainSelection = (event) => {
    if (selecting) event.preventDefault();
    selecting = false;
  };
  address.addEventListener("pointerdown", beginSelection);
  address.addEventListener("mouseup", retainSelection);
  // 기본값: 새 탭에는 저장된 주소(restored)가 없다. 주소 없이 빈 상태를 보이고, 아래에서 home 을 연다.
  showEmpty(restored ?? "");
  const composition = await context.composition.create({ regions: { page: area }, overlays: {} });
  const region = composition.region("page");
  const locationListeners = new Set();
  const addressListeners = new Set();
  const addressText = () => ({ value: address.value, focused: root.activeElement === address });
  const notifyAddress = () => { for (const listener of addressListeners) listener(addressText()); };
  // 사용자가 입력한 글자는 이동 명령이나 초점 해제 전까지 문서 상태로 덮지 않는다.
  // 입력 뒤 Enter 로 이동해도 주소창은 초점을 유지하므로 초점이 아니라 입력 여부로 판단한다.
  let editing = false;
  const typed = () => { editing = true; notifyAddress(); };
  const left = () => { editing = false; notifyAddress(); };
  const navigated = (run) => (params) => { editing = false; return run(params); };
  address.addEventListener("input", typed);
  address.addEventListener("focus", notifyAddress);
  address.addEventListener("blur", left);
  // 기본값: 새 탭에는 저장된 주소(restored)가 없다. 문서를 열기 전의 위치는 빈 주소다.
  let current = { url: restored ?? "", title: "", loading: false, progress: 0, canGoBack: false, canGoForward: false, error: null, scroll: { x: 0, y: 0 } };
  // 세션 기록은 문서 영역 상태의 history 다(docs/spec/native-surfaces.md#document-regions).
  let history = { entries: [], index: -1 };
  const historyListeners = new Set();
  // 문서의 요소와 기록된 요청도 영역 상태에서 온다.
  let elements = { nodes: [], truncated: false };
  let requests = { entries: [], truncated: false };
  const elementListeners = new Set();
  const requestListeners = new Set();
  // 기본값: 문서 제목이 비어 있으면 주소가 탭의 식별 텍스트다. 제어 문자를 지우고 256자로 자른다.
  const tabTitle = (state) => {
    // 기본값: 문서 제목이 비어 있으면 주소가 탭의 식별 텍스트다.
    const text = (state.title || state.url).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 256);
    context.tab.title(text === "" ? null : text);
  };
  const show = ({ history: sessionHistory, elements: documentElements, requests: documentRequests, ...state }) => {
    current = state;
    tabTitle(state);
    history = sessionHistory;
    elements = documentElements;
    requests = documentRequests;
    for (const listener of historyListeners) listener(history);
    for (const listener of elementListeners) listener(elements);
    for (const listener of requestListeners) listener(requests);
    showEmpty(state.url);
    if (state.url !== "") storage.setItem(storageKey, state.url);
    if (!editing) address.value = state.url;
    for (const listener of locationListeners) listener(current);
    notifyAddress();
  };
  const stopState = region.onState(show);
  // 문서의 페이지 확대는 이 표면의 실제 글자 배율이다(docs/spec/text-size.md).
  const textSize = context.runtime.textSize;
  await region.zoom(textSize.read());
  const stopTextSize = textSize.on((factor) => {
    region.zoom(factor).catch((error) => context.status.report("error", error));
  });
  context.exposure.status("browser.location", () => current, (fn) => {
    locationListeners.add(fn);
    fn(current);
    return () => locationListeners.delete(fn);
  });
  context.exposure.status("browser.history", () => history, (fn) => {
    historyListeners.add(fn);
    fn(history);
    return () => historyListeners.delete(fn);
  });
  context.exposure.status("browser.elements", () => elements, (fn) => {
    elementListeners.add(fn);
    fn(elements);
    return () => elementListeners.delete(fn);
  });
  context.exposure.status("browser.requests", () => requests, (fn) => {
    requestListeners.add(fn);
    fn(requests);
    return () => requestListeners.delete(fn);
  });
  context.exposure.command("browser.history.go", navigated(({ index }) => {
    if (!Number.isInteger(index) || index < 0 || index >= history.entries.length) {
      throw new Error(`history entry ${index} is outside the session history of ${history.entries.length} entries`);
    }
    if (index === history.index) return false;
    return region.entry(index - history.index);
  }));
  context.exposure.status("browser.address.text", addressText, (fn) => {
    addressListeners.add(fn);
    fn(addressText());
    return () => addressListeners.delete(fn);
  });
  context.exposure.command("browser.address.select", () => { address.focus(); address.select(); return null; });
  context.exposure.command("browser.navigate", navigated(({ url }) => region.load(url).then(() => null)));
  context.exposure.command("browser.back", navigated(() => region.back()));
  context.exposure.command("browser.forward", navigated(() => region.forward()));
  context.exposure.command("browser.reload", navigated(() => region.reload()));
  context.exposure.command("browser.stop", () => region.stop());
  context.exposure.dom("browser.address", address);
  context.exposure.dom("browser.document", area);
  context.exposure.dom("browser.empty", empty);
  context.exposure.dom("browser.back", root.querySelector('[data-command="browser.back"]'));
  context.exposure.dom("browser.forward", root.querySelector('[data-command="browser.forward"]'));
  context.exposure.dom("browser.reload", root.querySelector('[data-command="browser.reload"]'));
  await context.exposure.delegate(root);
  await context.exposure.bind(address, "browser.address.select", {}, { event: "focus" });
  await context.exposure.bind(address, "browser.navigate", () => {
    const value = address.value.trim();
    return { url: /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}` };
  }, { event: "keydown", when: (event) => event.key === "Enter" });
  // 저장된 주소가 없으면 설정 home 을 연다. 비어 있으면 빈 상태로 시작한다.
  // 기본값: 새 탭에는 저장된 주소(restored)가 없다. 그 탭은 설정 home 을 연다.
  const start = restored ?? context.runtime.settings.read().home;
  if (start !== "") await region.load(start);
  context.status.report("ready");
  return { async dispose() {
    address.removeEventListener("pointerdown", beginSelection);
    address.removeEventListener("mouseup", retainSelection);
    address.removeEventListener("input", typed);
    address.removeEventListener("focus", notifyAddress);
    address.removeEventListener("blur", left);
    addressListeners.clear();
    stopState();
    stopTextSize();
    locationListeners.clear();
    historyListeners.clear();
    elementListeners.clear();
    requestListeners.clear();
    await composition.dispose();
    await context.exposure.dispose();
    root.replaceChildren();
  } };
}
