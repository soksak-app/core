import { checkInput, cursor, pointer, region as regionMessages, scroll } from "./application-input.js";

// The view is the element of the image region; the application draws it, so the view has no background of its own.
const css = `:host{display:block;height:100%;background:transparent;position:relative}#view{position:absolute;inset:0;outline:0}[hidden]{display:none}`;

/**
 * The embed page of a connector plugin (docs/spec/plugins.md#connected-applications): it starts the application
 * `application` that the plugin connected, from the path that `runtime.applications` records, in the image region `view`
 * of the composition of that plugin. Its status `<plugin>.state`, commands `<plugin>.focus` and `<plugin>.input`, dom entry
 * `<plugin>.view` and events `plugin.<plugin>.open|input|message|error` carry the id of that plugin, which declares them.
 */
export async function mountApplication(root, context, { application }) {
  const id = context.pluginId;
  root.innerHTML = `<style>${css}</style><div id="view" data-expose="${id}.view" data-command="${id}.focus" tabindex="0"></div>`;
  const view = root.querySelector("#view");
  const settings = context.runtime.settings.read();
  // The setting arguments holds the arguments of the program as a JSON array of strings, so a path with spaces keeps
  // its form; another value is an error and starts nothing.
  let args = null;
  try {
    const parsed = JSON.parse(settings.arguments);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) args = parsed;
  } catch {
    // reported below: the value is not JSON
  }
  // An application that is not connected is an error and starts nothing.
  // default: an application without a record is not connected; null names that state and is reported below.
  const record = context.runtime.applications.read()[application] ?? null;
  const program = args === null || record === null ? null : record.path;
  // A shown image region holds the composition until its first frame, so only a running application shows it.
  view.hidden = program === null;
  const sidecar = context.runtime.sidecar();
  // The host finishes the composition only after the first frame of the image region, which the application draws, so
  // the page subscribes to the sidecar and opens the application before it creates the composition; a message that
  // needs the region waits for it.
  let regionReady;
  const imageRegion = new Promise((resolve) => { regionReady = resolve; });
  let state = { program, pid: null, toolkit: null, cursor: "default", title: null, exit: null, error: null };
  const watchers = new Set();
  const changed = (fields) => { state = { ...state, ...fields }; watchers.forEach((fn) => fn(state)); };
  const report = (text) => {
    changed({ error: text });
    context.runtime.log.warn("error", { error: text });
    context.status.report("error", new Error(text));
  };
  let inputs = 0;
  const send = (message) => {
    context.runtime.log.trace("input", { type: message.type });
    return sidecar.send(context.surfaceId, { operation: "input", message }).catch((error) => report(`input: ${error.message}`));
  };
  await sidecar.on(context.surfaceId, (body) => {
    // default: a message of the sidecar without an event is its error message.
    context.runtime.log.debug("message", { event: body.event ?? "error" });
    if (body.error !== undefined) return report(body.error);
    if (body.event === "started") return changed({ pid: body.pid, exit: null });
    if (body.event === "connected") return changed({ toolkit: body.toolkit });
    if (body.event === "cursor") {
      try {
        view.style.cursor = cursor(body.shape);
        return changed({ cursor: body.shape });
      } catch (error) {
        return report(error.message);
      }
    }
    if (body.event === "caret") {
      return imageRegion.then((image) => image.setCaret({ x: body.x, y: body.y, width: body.width, height: body.height })).catch((error) => report(`caret: ${error.message}`));
    }
    if (body.event === "state") return changed({ title: body.title });
    if (body.event === "exited") return changed({ exit: body.exit });
    return report(`unknown message of the sidecar ${JSON.stringify(body)}`);
  });
  if (program !== null) {
    context.runtime.log.info("open", { program });
    await sidecar.send(context.surfaceId, { operation: "open", command: [program, ...args] });
  }
  const composition = await context.composition.create({ regions: { view }, overlays: {} });
  const image = composition.region("view");
  regionReady(image);
  await Promise.all([
    context.exposure.status(`${id}.state`, () => state, (fn) => { watchers.add(fn); return () => watchers.delete(fn); }),
    context.exposure.command(`${id}.focus`, async () => { await (await imageRegion).focus(); return null; }),
    context.exposure.command(`${id}.input`, async ({ message }) => { await send(checkInput(message)); return null; }),
    context.exposure.dom(`${id}.view`, view),
  ]);
  await context.exposure.delegate(root);
  await context.exposure.bind(view, `${id}.focus`, () => ({}), { event: "pointerdown" });
  const rect = () => view.getBoundingClientRect();
  for (const [type, phase] of [["pointerdown", "down"], ["pointermove", "move"], ["pointerup", "up"]]) {
    view.addEventListener(type, (event) => {
      if (type === "pointerdown") view.setPointerCapture(event.pointerId);
      send(pointer(phase, event, rect(), ++inputs));
    });
  }
  view.addEventListener("wheel", (event) => { event.preventDefault(); send(scroll(event, rect(), ++inputs)); }, { passive: false });
  for (const type of ["key", "insert", "compose", "focus"]) {
    image.on(type, async (event) => { for (const message of regionMessages(type, event)) await send(message); });
  }
  image.on("error", (event) => report(`native image: ${event.reason}`));
  if (args === null) {
    report(`the setting arguments is not a JSON array of strings: ${settings.arguments}`);
    return { dispose: () => composition.dispose() };
  }
  if (record === null) {
    report(`the application ${application} is not connected`);
    return { dispose: () => composition.dispose() };
  }
  context.status.report("ready");
  return {
    focus: () => image.focus(),
    async dispose() {
      await composition.dispose();
      await context.exposure.dispose();
      root.replaceChildren();
    },
  };
}
