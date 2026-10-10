// The always-on core exposure for mounted surfaces. Diagnostic fixture, drag, and transcript code is staged separately
// through diagnostics.js and does not belong to this module.
const INPUT_TYPES = ["pointerdown", "pointerup", "pointermove", "click", "wheel", "keydown"];
const INPUT_KEPT = 32;
// The modifier keys that the event carries. The flags of the native event are exposed as they are.
const MODIFIERS = [["shiftKey", "shift"], ["altKey", "alt"], ["ctrlKey", "control"], ["metaKey", "command"]];

// root is the shadow root of the surface host element, and view is the window of that document. If declarations is null, every exposure is registered.
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
      // body is the visible box plus the content that overflows or scrolls, and viewport is the visible box.
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
      // default: a pointer event has no key, so key is null.
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
