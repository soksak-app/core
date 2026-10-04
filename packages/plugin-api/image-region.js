// 표면 페이지의 요소 하나에 붙는 그림 영역.
//
// 호스트는 표면 웹뷰 안에 그림 영역을 두고, 이 모듈이 알린 뷰포트 여백으로 배치한다. 요소의
// 위치와 크기는 ResizeObserver 와 창 resize, scroll 이벤트로 따라간다.

import { regionInsets, observeRegionInsets } from "./document-region.js";

/** 이름 규칙. 호스트도 같은 규칙으로 확인한다. */
export const IMAGE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * element 에 그림 영역 name 을 붙인다. port 는 런타임의 page.image 이고 view 는 요소의 창이다.
 * 반환한 영역의 호출은 붙이기가 끝난 뒤 순서대로 실행된다. detach 뒤에는 호출할 수 없다.
 */
export function attachImage(port, element, name, sidecar, view = element.ownerDocument.defaultView, options = {}) {
  if (!IMAGE_NAME.test(name)) throw new Error(`invalid image name ${JSON.stringify(name)}`);
  // 호출자에게 돌아가지 않는 실패(관찰 중의 배치, 처리할 곳이 없는 사건)는 이 함수로 오류를 알린다.
  const { report } = options;
  if (typeof report !== "function") throw new TypeError(`image ${name} requires a report for its failures`);
  const listeners = new Map();
  let detached = false;
  let chain = port.attach(name, sidecar);
  const queue = (work) => {
    if (detached) return Promise.reject(new Error(`image ${name} is detached`));
    const next = chain.then(work);
    // 실패는 next 를 받은 호출자에게 rejection 으로 전달된다. 체인은 다음 작업을 위해 그 실패 뒤에도 이어진다.
    chain = next.then(() => undefined, () => undefined);
    return next;
  };

  const unlisten = Promise.resolve(port.on((imageName, event) => {
    if (imageName !== name || detached) return;
    const eventType = typeof event === "string" ? event : event?.type;
    // 처리할 곳이 없는 사건은 버리지 않고 오류로 알린다.
    if (!eventType) {
      report(`image ${name}: event has no type: ${JSON.stringify(event)}`);
      return;
    }
    const handlers = listeners.get(eventType);
    if (!handlers) {
      report(`image ${name}: no handlers for event type ${eventType}`);
      return;
    }
    for (const fn of handlers) fn(event);
  }));

  const placeAt = ({ insets, visible }) => queue(() => port.place(name, insets, visible));
  // 기본값: 던진 값이 Error 가 아닐 수 있으므로 message 가 없으면 그 값을 그대로 적는다.
  const failed = (error) => report(`image ${name} place: ${error?.message ?? error}`);
  const stopObserving = options.observe === false ? () => {} : observeRegionInsets(element, view, placeAt, failed);

  return {
    name,
    _ready: chain,
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },
    focus() {
      return queue(() => port.focus(name));
    },
    setCaret(rect) {
      return queue(() => port.caret(name, rect.x, rect.y, rect.width, rect.height));
    },
    setAccessibleText(text) {
      return queue(() => port.text(name, text));
    },
    visible(v) {
      const { insets } = regionInsets(element, view);
      return placeAt({ insets, visible: v });
    },
    _place: placeAt,
    detach() {
      const done = queue(() => port.detach(name));
      detached = true;
      stopObserving();
      listeners.clear();
      unlisten.then((stop) => stop());
      return done;
    },
  };
}
