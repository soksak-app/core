// Always-on core exposure for a mounted surface. Diagnostic fixture/drag/transcript code is
// staged separately through diagnostics.js and is not part of this module.
const INPUT_TYPES = ["pointerdown", "pointerup", "pointermove", "click", "wheel", "keydown"];
const INPUT_KEPT = 32;

export function registerSurfaceExposure({ root, expose, view = root.ownerDocument?.defaultView ?? globalThis, declarations = null }) {
  if (!root || !expose) throw new TypeError("surface exposure requires a root and exposure");
  const host = root.host ?? root;
  const doc = host.ownerDocument ?? view.document;
  const rect = () => host.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 };
  const events = [];
  let sequence = 0;
  let documentNotify = null;
  let inputNotify = null;
  const removers = [];
  const observers = [];
  const readDocument = () => {
    const frame = rect();
    const style = view.getComputedStyle?.(host);
    const documentStyle = view.getComputedStyle?.(doc.documentElement);
    return {
      url: view.location?.href ?? "", timeOrigin: view.performance?.timeOrigin ?? 0,
      readyState: doc.readyState,
      themed: Boolean(style?.getPropertyValue("--bg") || (style?.colorScheme && style.colorScheme !== "normal")),
      scale: view.devicePixelRatio ?? 1,
      body: { width: frame.width, height: frame.height },
      viewport: { width: frame.width, height: frame.height },
      filter: documentStyle?.filter ?? "none", unbound: expose.audit(root),
    };
  };
  const readInput = () => events.slice();
  const onInput = (event) => {
    const frame = rect();
    events.push({ sequence: ++sequence, type: event.type, trusted: event.isTrusted,
      x: event.clientX === undefined ? null : event.clientX - frame.left,
      y: event.clientY === undefined ? null : event.clientY - frame.top, key: event.key ?? null });
    if (events.length > INPUT_KEPT) events.shift();
    inputNotify?.();
  };
  for (const type of INPUT_TYPES) {
    root.addEventListener?.(type, onInput, true);
    removers.push(() => root.removeEventListener?.(type, onInput, true));
  }
  const mutation = typeof MutationObserver === "function" ? new MutationObserver(() => documentNotify?.()) : null;
  mutation?.observe(root, { subtree: true, childList: true, attributes: true,
    attributeFilter: ["data-command", "data-expose", "role", "contenteditable", "style", "class"] });
  if (mutation) observers.push(() => mutation.disconnect());
  const declared = (kind, name) => declarations === null || declarations[kind]?.some((entry) => entry.name === name);
  const registrations = [];
  if (declared("status", "core.surface.document")) registrations.push(
    expose.status("core.surface.document", readDocument, (notify) => { documentNotify = notify; return () => { documentNotify = null; }; }));
  if (declared("status", "core.surface.input")) registrations.push(
    expose.status("core.surface.input", readInput, (notify) => { inputNotify = notify; return () => { inputNotify = null; }; }));
  if (declared("commands", "core.surface.hit")) registrations.push(expose.command("core.surface.hit", ({ x, y }) => {
    const frame = rect();
    const target = doc.elementFromPoint?.(x + frame.left, y + frame.top);
    return Boolean(target && (target === host || host.contains?.(target) || root.contains?.(target)));
  }));
  return { ready: Promise.all(registrations), dispose() {
    for (const remove of removers) remove();
    for (const stop of observers) stop();
  } };
}
