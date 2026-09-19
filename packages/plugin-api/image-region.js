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
export function attachImage(port, element, name, sidecar, view = element.ownerDocument.defaultView) {
  if (!IMAGE_NAME.test(name)) throw new Error(`invalid image name ${JSON.stringify(name)}`);
  const listeners = new Map();
  let detached = false;
  let chain = port.attach(name, sidecar);
  const queue = (work) => {
    if (detached) return Promise.reject(new Error(`image ${name} is detached`));
    const next = chain.then(work);
    // 내부 체인에서만 에러를 기록한다. 호출자는 next를 받으므로 실패 시 rejection이 전달된다.
    chain = next.catch((error) => {
      console.error(`image ${name} operation failed:`, error?.message ?? error);
    });
    return next;
  };

  const unlisten = Promise.resolve(port.on((imageName, event) => {
    if (imageName !== name || detached) return;
    const eventType = typeof event === "string" ? event : event?.type;
    if (!eventType) {
      console.warn(`image ${name}: event has no type`, event);
      return;
    }
    const handlers = listeners.get(eventType);
    if (!handlers) {
      console.warn(`image ${name}: no handlers for event type ${eventType}`);
      return;
    }
    for (const fn of handlers) fn(event);
  }));

  const stopObserving = observeRegionInsets(element, view, ({ insets, visible }) =>
    queue(() => port.place(name, insets, visible))
      .catch((error) => console.error(`image ${name} place: ${error.message}`)));

  return {
    name,
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
      return queue(() => port.place(name, insets, v));
    },
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
