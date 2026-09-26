// Always-on core exposure for a mounted surface. Diagnostic fixture/drag/transcript code is
// staged separately through diagnostics.js and is not part of this module.
const INPUT_TYPES = ["pointerdown", "pointerup", "pointermove", "click", "wheel", "keydown"];
const INPUT_KEPT = 32;
// 이벤트가 담은 수정 키. 네이티브 이벤트의 플래그가 그대로 드러난다.
const MODIFIERS = [["shiftKey", "shift"], ["altKey", "alt"], ["ctrlKey", "control"], ["metaKey", "command"]];

// root 는 표면 호스트 요소의 그림자 루트, view 는 그 문서의 창이다. declarations 가 null 이면 모든 노출을 등록한다.
export function registerSurfaceExposure({ root, expose, view, declarations = null }) {
  if (!root?.host || !expose || !view) throw new TypeError("surface exposure requires a shadow root, exposure, and a view");
  const host = root.host;
  const doc = host.ownerDocument;
  const rect = () => host.getBoundingClientRect();
  const events = [];
  let sequence = 0;
  let documentNotify = null;
  let inputNotify = null;
  const removers = [];
  const observers = [];
  const readDocument = () => {
    const frame = rect();
    const style = view.getComputedStyle(host);
    const documentStyle = view.getComputedStyle(doc.documentElement);
    return {
      url: view.location.href, timeOrigin: view.performance.timeOrigin,
      readyState: doc.readyState,
      themed: Boolean(style.getPropertyValue("--bg") || (style.colorScheme && style.colorScheme !== "normal")),
      scale: view.devicePixelRatio,
      // body 는 보이는 상자에 넘치거나 스크롤되는 내용을 더한 크기, viewport 는 보이는 상자다.
      body: {
        width: frame.width + Math.max(0, host.scrollWidth - host.clientWidth),
        height: frame.height + Math.max(0, host.scrollHeight - host.clientHeight),
      },
      viewport: { width: frame.width, height: frame.height },
      filter: documentStyle.filter, unbound: expose.audit(root),
    };
  };
  const readInput = () => events.slice();
  const onInput = (event) => {
    const frame = rect();
    events.push({ sequence: ++sequence, type: event.type, trusted: event.isTrusted,
      x: event.clientX === undefined ? null : event.clientX - frame.left,
      // 기본값: 포인터 이벤트에는 키가 없으므로 key 는 null 이다.
      y: event.clientY === undefined ? null : event.clientY - frame.top, key: event.key ?? null,
      modifiers: MODIFIERS.filter(([property]) => event[property]).map(([, name]) => name) });
    if (events.length > INPUT_KEPT) events.shift();
    if (inputNotify) inputNotify();
  };
  for (const type of INPUT_TYPES) {
    root.addEventListener(type, onInput, true);
    removers.push(() => root.removeEventListener(type, onInput, true));
  }
  const mutation = new view.MutationObserver(() => { if (documentNotify) documentNotify(); });
  mutation.observe(root, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["data-command", "data-expose", "role", "contenteditable", "style", "class"] });
  observers.push(() => mutation.disconnect());
  const declared = (kind, name) => declarations === null || declarations[kind]?.some((entry) => entry.name === name);
  const registrations = [];
  if (declared("status", "core.surface.document")) registrations.push(
    expose.status("core.surface.document", readDocument, (notify) => { documentNotify = notify; return () => { documentNotify = null; }; }));
  if (declared("status", "core.surface.input")) registrations.push(
    expose.status("core.surface.input", readInput, (notify) => { inputNotify = notify; return () => { inputNotify = null; }; }));
  if (declared("commands", "core.surface.hit")) registrations.push(expose.command("core.surface.hit", ({ x, y }) => {
    const frame = rect();
    const target = doc.elementFromPoint(x + frame.left, y + frame.top);
    return Boolean(target && (target === host || host.contains(target) || root.contains(target)));
  }));
  return { ready: Promise.all(registrations), dispose() {
    for (const remove of removers) remove();
    for (const stop of observers) stop();
  } };
}
