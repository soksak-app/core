// 메인 문서의 키보드 초점. 표면 모듈은 메인 문서의 shadow root 안에 마운트되므로, 문서의 activeElement 와 focus
// 사건의 target 은 shadow host 로 바뀌어 보인다. 초점은 shadow root 를 따라가 실제 요소에서 읽는다.

/** 초점을 가진 가장 안쪽 요소. 초점이 없으면 null 이다. */
function deepActive(document) {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}

/** 요소가 속한 표면의 id. 메인 문서의 요소는 null 이다. */
function surfaceOf(element) {
  const root = element.getRootNode();
  // 기본값: shadow root 밖의 요소는 메인 문서에 속하므로 표면이 없다(null).
  if (!root.host) return null;
  // 기본값: 표면 슬롯 밖의 shadow root 는 표면에 속하지 않는다(null).
  return root.host.closest("[data-native-surface-id]")?.dataset.nativeSurfaceId ?? null;
}

/**
 * 키보드 초점을 가진 공개 요소의 이름, 그 문서(또는 shadow root) 안에서의 순번, 표면 id.
 * 초점이 공개 요소 밖에 있으면 null 이다.
 */
export function focusState(document) {
  const element = deepActive(document)?.closest("[data-expose]");
  if (!element || element === document.body) return null;
  const name = element.dataset.expose;
  const root = element.getRootNode();
  return { name, index: [...root.querySelectorAll(`[data-expose="${name}"]`)].indexOf(element), surface: surfaceOf(element) };
}

/**
 * focus 사건이 가리키는 실제 요소의 이름. 공개 이름이 없으면 태그 이름이다. 관측 줄의 식별자이며 판정에 쓰지 않는다.
 */
export function focusName(event) {
  const target = event.composedPath()[0];
  if (!(target instanceof target.ownerDocument.defaultView.Element)) return "unknown";
  // 기본값: 공개 이름이 없는 요소는 태그 이름으로 적는다. 관측 식별자일 뿐 판정에 쓰지 않는다.
  return target.closest("[data-expose]")?.dataset.expose ?? target.tagName;
}
