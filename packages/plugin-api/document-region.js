// 표면 페이지의 요소 하나에 붙는 문서 영역. docs/spec/native-surfaces.md 의 "문서 영역"이다.
//
// 호스트는 표면 웹뷰 안에 문서 웹뷰를 두고, 이 모듈이 알린 뷰포트 여백으로 배치한다. 요소의
// 위치와 크기는 ResizeObserver 와 창 resize, scroll 이벤트로 따라간다. 요소나 조상의 크기가
// 바뀌지 않고 위치만 바뀌는 배치는 조상의 크기 변화로 드러난다.

/** 이름 규칙. 호스트도 같은 규칙으로 확인한다. */
export const DOCUMENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const DOCUMENT_ACTIONS = Object.freeze(["back", "forward", "reload", "stop"]);

/**
 * 요소와 조상이 CSS visibility/display로 숨겨져 있는지 확인한다.
 * getComputedStyle을 사용하여 표준 방법으로 판정한다.
 * 모든 지원 범위(macOS 14.0+)에서 작동한다.
 */
function isElementVisible(element, view) {
  // 요소부터 시작하여 조상 체인을 따라가며 visibility/display 확인
  let el = element;
  while (el && el !== view.document.body.parentElement) {
    const style = view.getComputedStyle(el);
    // visibility: hidden 또는 display: none 이면 보이지 않음
    if (style.visibility === "hidden" || style.display === "none") {
      return false;
    }
    el = el.parentElement;
  }
  return true;
}

/** 요소의 뷰포트 여백. 요소가 표시되지 않으면 visible 이 false 다. */
export function regionInsets(element, view) {
  const rect = element.getBoundingClientRect();
  const insets = {
    left: rect.left,
    top: rect.top,
    right: view.visualViewport.width - rect.right,
    bottom: view.visualViewport.height - rect.bottom,
  };
  const shown = element.isConnected && rect.width > 0 && rect.height > 0
    && isElementVisible(element, view);
  return { insets, visible: shown };
}

/**
 * 요소의 뷰포트 여백을 관찰하고 변화를 onPlace 로 통보한다. 관찰을 멈길 수 있는 정리 함수를 반환한다.
 * onPlace 는 비동기 작업을 되돌려주고, 반환이 이행되어야 다음 배치를 보낸다.
 */
export function observeRegionInsets(element, view, onPlace) {
  let placed = null;
  let detached = false;
  const place = () => {
    if (detached) return;
    const next = regionInsets(element, view);
    const key = JSON.stringify(next);
    if (key === placed) return;
    placed = key;
    onPlace(next).catch((error) => {
      // 배치 작업이 실패해도 관찰은 계속 진행한다. 실패를 기록한다.
      console.error(`place operation failed: ${error?.message ?? error}`);
    });
  };
  const observer = new view.ResizeObserver(place);
  for (let node = element; node; node = node.parentElement) observer.observe(node);
  view.addEventListener("resize", place);
  view.addEventListener("scroll", place, true);
  place();
  return () => {
    detached = true;
    observer.disconnect();
    view.removeEventListener("resize", place);
    view.removeEventListener("scroll", place, true);
  };
}

/**
 * element 에 문서 영역 name 을 붙인다. port 는 런타임의 page.document 이고 view 는 요소의 창이다.
 *
 * 반환한 영역의 호출은 붙이기가 끝난 뒤 순서대로 실행된다. state 는 호스트가 마지막으로 알린
 * 문서 상태이고 onState 는 상태가 바뀔 때마다 호출된다. detach 뒤에는 호출할 수 없다.
 */
export function attachRegion(port, element, name, view = element.ownerDocument.defaultView, options = {}) {
  if (!DOCUMENT_NAME.test(name)) throw new Error(`invalid document name ${JSON.stringify(name)}`);
  const listeners = new Set();
  let state = null;
  let detached = false;
  let chain = port.attach(name);
  const queue = (work) => {
    if (detached) return Promise.reject(new Error(`document ${name} is detached`));
    const next = chain.then(work);
    // 내부 체인에서만 에러를 기록한다. 호출자는 next를 받으므로 실패 시 rejection이 전달된다.
    chain = next.catch((error) => {
      console.error(`document ${name} operation failed:`, error?.message ?? error);
    });
    return next;
  };

  const unlisten = Promise.resolve(port.onState((document, value) => {
    if (document !== name || detached) return;
    state = value;
    for (const fn of listeners) fn(value);
  }));

  const placeAt = ({ insets, visible }) => queue(() => port.place(name, insets, visible));
  const stopObserving = options.observe === false ? () => {} : observeRegionInsets(element, view, (placement) =>
    placeAt(placement).catch((error) => console.error(`document ${name} place: ${error.message}`)));

  return {
    name,
    _ready: chain,
    get state() { return state; },
    onState(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** 요소가 바뀐 배치를 알린다. 관찰로 드러나지 않는 이동에 쓴다. */
    place: () => {
      const { insets, visible } = regionInsets(element, view);
      return placeAt({ insets, visible })
        .catch((error) => console.error(`document ${name} place: ${error.message}`));
    },
    _place: placeAt,
    load: (url) => queue(() => port.load(name, url)),
    /** 문서의 페이지 확대를 글자 배율로 정한다(docs/spec/text-size.md). */
    zoom: (factor) => queue(() => port.zoom(name, factor)),
    go(action) {
      if (!DOCUMENT_ACTIONS.includes(action)) return Promise.reject(new Error(`unknown document action ${action}`));
      return queue(() => port.go(name, action));
    },
    back() { return this.go("back"); },
    forward() { return this.go("forward"); },
    reload() { return this.go("reload"); },
    stop() { return this.go("stop"); },
    detach() {
      const done = queue(() => port.detach(name));
      detached = true;
      stopObserving();
      listeners.clear();
      unlisten.then((stop) => stop?.());
      return done;
    },
  };
}
