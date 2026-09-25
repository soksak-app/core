const css = `:host{display:flex;height:100%;flex-direction:column;background:var(--card);color:var(--fg);font:12px/1.4 var(--font)}#bar{display:flex;gap:4px;padding:4px 6px;border-bottom:1px solid var(--rule)}button{border:0;background:transparent;color:inherit}input{flex:1;min-width:0;background:transparent;color:inherit;border:1px solid var(--edge);border-radius:5px;padding:3px 8px}#document,#empty{flex:1;min-height:0}#empty{display:flex;align-items:center;justify-content:center;color:var(--muted);cursor:text}[hidden]{display:none!important}`;

export async function mount(root, context) {
  if (typeof context.surfaceId !== "string" || context.surfaceId === "") {
    throw new TypeError("browser surface requires a surfaceId for location persistence");
  }
  root.innerHTML = `<style>${css}</style><div id="bar"><button data-command="browser.back">‹</button><button data-command="browser.forward">›</button><button data-command="browser.reload">↻</button><input id="address" data-expose="browser.address" aria-label="주소"></div><div id="document" data-expose="browser.document"></div><div id="empty" data-expose="browser.empty" data-command="browser.address.select">주소를 입력하세요</div>`;
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
  showEmpty(restored ?? "");
  const composition = await context.composition.create({ regions: { page: area }, overlays: {} });
  const region = composition.region("page");
  const locationListeners = new Set();
  let current = { url: restored ?? "", title: "", loading: false, progress: 0, canGoBack: false, canGoForward: false, error: null, scroll: { x: 0, y: 0 } };
  const show = (state) => {
    current = state;
    showEmpty(state.url);
    if (state.url !== "") storage.setItem(storageKey, state.url);
    if (root.getRootNode().activeElement !== address) address.value = state.url;
    for (const listener of locationListeners) listener(current);
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
  context.exposure.command("browser.address.select", () => { address.focus(); address.select(); return null; });
  context.exposure.command("browser.navigate", ({ url }) => region.load(url).then(() => null));
  context.exposure.command("browser.back", () => region.back());
  context.exposure.command("browser.forward", () => region.forward());
  context.exposure.command("browser.reload", () => region.reload());
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
  if (restored ?? context.metadata.home) await region.load(restored ?? context.metadata.home);
  context.status.report("ready");
  return { async dispose() {
    address.removeEventListener("pointerdown", beginSelection);
    address.removeEventListener("mouseup", retainSelection);
    stopState();
    stopTextSize();
    locationListeners.clear();
    await composition.dispose();
    await context.exposure.dispose();
    root.replaceChildren();
  } };
}
