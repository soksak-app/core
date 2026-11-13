// The view of the raster probe: one image region that the fake persistent sidecar @sok-check/sidecar-rasterprobe draws
// (docs/spec/native-surfaces.md#image-regions, docs/spec/persistent-services.md). The view opens the session of its surface with its
// image before it sends any other request: a view of a reloaded page starts with a surface whose session the close of the old page
// may have ended, and a request before the open would reach a surface without a session. It forwards the text size factor of the surface and the input of the region to the sidecar, opens the session again on each
// connection notice of the sidecar, and reports the view, the session, the last frame and the input of the region as statuses. A
// primary press on the region gives it the keyboard focus, as a view whose region takes text does (a press passes through the
// region to the page, docs/spec/native-surfaces.md#image-regions). A hide, a show and a reload of the view are the host's: the host
// detaches the image of a reloaded page and the new page opens the same session again, so the view keeps no state of its own.

export const SIDECAR = "@sok-check/sidecar-rasterprobe";
export const REGION = "raster";
/** The number of input transactions that rasterprobe.input keeps in its log, and of pointer events in its pointer list. */
export const INPUT_LOG_LIMIT = 256;
export const POINTER_LIMIT = 64;

/** The exposure port of the probe view: registrations, replies and watched status values go through the view bridge. */
export function probeExposurePort(bridge) {
  return {
    register: bridge.exposure.register,
    reply: bridge.exposure.reply,
    changed: bridge.exposure.changed,
    report: (text) => bridge.runtime.error("rasterprobe exposure", text),
    onRequest: (answer) => bridge.runtime.native.on("exposure-request", answer),
  };
}

/** A status value and its listeners. */
function statusCell(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    read: () => value,
    set(next) {
      value = next;
      for (const listener of [...listeners]) listener(value);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The session status before the sidecar answered. */
const NO_SESSION = Object.freeze({ session: null, connected: false, failure: null, error: null });

/**
 * Starts the probe. bridge is the view bridge, expose the exposure of the page, view the window of the view (its sokSurface,
 * devicePixelRatio and ResizeObserver) and document its document.
 */
export async function startRasterProbe({ bridge, expose, document, view }) {
  const surface = view.sokSurface.surface;
  const sidecar = bridge.runtime.sidecar(SIDECAR);
  const element = document.getElementById(REGION);
  // default: a surface whose text size the workbench does not know (a section that is not shown) draws at factor 1.
  let factor = (await bridge.runtime.textSize.read()) ?? 1;

  const viewStatus = statusCell(null);
  const sessionStatus = statusCell(NO_SESSION);
  const frameStatus = statusCell(null);
  const inputStatus = statusCell({ focused: false, transactions: 0, preedit: null, actions: [], errors: [], log: [], pointer: [],
    pressFocus: 0 });
  const changeInput = (change) => inputStatus.set({ ...inputStatus.read(), ...change(inputStatus.read()) });

  const measure = () => {
    const rect = element.getBoundingClientRect();
    const ratio = view.devicePixelRatio;
    viewStatus.set({
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
      deviceWidth: Math.round(rect.width * ratio),
      deviceHeight: Math.round(rect.height * ratio),
      devicePixelRatio: ratio,
      textSize: factor,
    });
  };
  const report = (text) => {
    sessionStatus.set({ ...sessionStatus.read(), error: text });
    bridge.runtime.error("rasterprobe", text);
  };
  const send = (body, cids) => sidecar.send(surface, body, cids);
  const open = () => send({ operation: "open", image: REGION, textSize: factor });

  // The sidecar names in each frame event the sequences of the inputs that it handled since its frame before; the frame is the first
  // that shows the state after each of them, so each entry of the log keeps the identity of that frame.
  const presented = (body) => {
    if (!Array.isArray(body.inputs)) {
      report(`the sidecar sent frame ${body.sequence} without its inputs`);
      return;
    }
    const frame = { generation: body.generation, raster: body.raster, sequence: body.sequence };
    const { log, transactions } = inputStatus.read();
    const shown = new Set();
    for (const sequence of body.inputs) {
      const entry = log.find((item) => item.sequence === sequence);
      if (entry === undefined) {
        // default: an input that the log no longer holds (cleared or past its limit) is not attributed; one it never held is reported.
        if (!(Number.isInteger(sequence) && sequence >= 1 && sequence <= transactions)) {
          report(`the sidecar presented input ${JSON.stringify(sequence)}, which the view never sent`);
        }
        continue;
      }
      if (entry.frame !== null || shown.has(sequence)) {
        report(`the sidecar presented input ${sequence} twice`);
        continue;
      }
      shown.add(sequence);
    }
    if (shown.size > 0) changeInput(({ log: current }) => ({ log: current.map((item) => (shown.has(item.sequence) ? { ...item, frame } : item)) }));
  };
  // default: the host leaves out the cids of an answer whose line names none, so the listener receives no identifiers.
  const answer = (body, cids = []) => {
    if (typeof body?.error === "string") {
      report(body.reason === undefined ? body.error : `${body.error}: ${body.reason}`);
      return;
    }
    switch (body?.event) {
      case "session":
      case "state":
        sessionStatus.set({ ...body, connected: true, failure: null, error: null });
        return;
      case "frame":
        frameStatus.set(body);
        presented(body);
        return;
      case "rows":
        sessionStatus.set({ ...sessionStatus.read(), rows: body.count });
        return;
      case "color":
        sessionStatus.set({ ...sessionStatus.read(), color: body.color });
        return;
      case "textSize":
        sessionStatus.set({ ...sessionStatus.read(), textSize: body.factor });
        return;
      case "closed":
        sessionStatus.set({ ...NO_SESSION, connected: true });
        return;
      case "input": {
        // The sidecar answers each input request once with the body it received, which names the sequence of the transaction.
        const sequence = body.received?.sequence;
        const entry = inputStatus.read().log.find((item) => item.sequence === sequence);
        if (entry === undefined) {
          // default: an answer whose transaction left the log (or never existed) is reported, not dropped silently.
          report(`the sidecar answered input ${JSON.stringify(sequence)}, which the log does not hold`);
          return;
        }
        if (entry.received !== null) {
          report(`the sidecar answered input ${sequence} twice`);
          return;
        }
        changeInput(({ log }) => ({ log: log.map((item) => (item === entry ? { ...item, received: body.received, receivedCids: cids } : item)) }));
        return;
      }
      case "connection":
        // The sidecar connected again: a preserved session answers the open as it is, and a new service opens a new one
        // (docs/spec/persistent-services.md#service-transport).
        if (body.connected) open().catch((error) => report(`open after a connection: ${error.message}`));
        else sessionStatus.set({ ...sessionStatus.read(), connected: false, failure: body.reason ?? null });
        return;
      default:
        report(`the sidecar sent an unknown message ${JSON.stringify(body)}`);
    }
  };
  await sidecar.on(surface, answer);
  await sidecar.onFailure(surface, (reason) => sessionStatus.set({ ...sessionStatus.read(), connected: false, failure: reason }));
  // The open comes first: the region, the commands and the text size listener created below are the sources of every other request.
  await open();

  // The input handler of the region is given with the creation, so a focus report or a key that arrives while the region
  // attaches reaches it in its dispatch (docs/spec/native-surfaces.md#image-regions).
  const input = (event) => {
    // default: an input event that names no correlation identifier continues no input of the native layer.
    const cids = event.cids ?? [];
    const actions = event.actions ?? [];
    const preedit = event.preedit ?? null;
    const errors = event.errors ?? [];
    const sequence = inputStatus.read().transactions + 1;
    // The transaction carries the focus changes of its scope as focus actions in their order, and the last one is the focus
    // after it (docs/spec/native-surfaces.md#image-regions); the focus report of a region that takes the first responder as it
    // shows comes this way.
    const focus = actions.filter((action) => action.type === "focus").at(-1);
    changeInput(({ log, focused }) => ({
      focused: focus === undefined ? focused : focus.focused === true,
      transactions: sequence,
      preedit,
      actions,
      errors,
      log: [...log, { sequence, cids, actions, preedit, errors, received: null, receivedCids: null, frame: null }].slice(-INPUT_LOG_LIMIT),
    }));
    send({ operation: "input", sequence, actions, preedit }, cids).catch((error) => report(`input: ${error.message}`));
  };
  const composition = await bridge.composition.create({ regions: { [REGION]: element }, overlays: {}, input: { [REGION]: input } });
  const image = composition.region(REGION);
  image.on("focus", (event) => changeInput(() => ({ focused: event.focused === true })));
  image.on("compose", (event) => changeInput(() => ({ preedit: event })));
  const pointer = (event) => {
    changeInput(({ pointer: list }) => ({
      pointer: [...list, { type: event.type, button: event.button, trusted: event.isTrusted === true }].slice(-POINTER_LIMIT),
    }));
    // pressFocus counts the answers of the focus calls of the presses: the host answers a call after it gave the region the keyboard
    // or set the move to wait for the release of the press (docs/spec/native-surfaces.md#keyboard-of-a-surface).
    if (event.type === "pointerdown" && event.button === 0) {
      image.focus().catch((error) => report(`focus on press: ${error.message}`))
        .finally(() => changeInput(({ pressFocus }) => ({ pressFocus: pressFocus + 1 })));
    }
  };
  element.addEventListener("pointerdown", pointer);
  element.addEventListener("pointerup", pointer);
  image.on("action", () => {});
  image.on("error", (event) => report(`image ${REGION}: ${event.reason}`));

  const command = (name, run) => bridge.commands.register(name, async (params) => {
    await run(params ?? {});
    return null;
  });
  await command("rasterprobe.rows", ({ count }) => send({ operation: "rows", count }));
  await command("rasterprobe.color", ({ color }) => send({ operation: "color", color }));
  await command("rasterprobe.state", () => send({ operation: "state" }));
  await command("rasterprobe.focus", () => image.focus());
  await command("rasterprobe.input.clear", () => changeInput(() => ({ log: [], pointer: [] })));
  await command("rasterprobe.close", () => send({ operation: "close" }));
  await command("rasterprobe.kill", () => send({ operation: "kill" }));
  const status = (name, cell) => expose.status(name, cell.read, cell.subscribe);
  await status("rasterprobe.view", viewStatus);
  await status("rasterprobe.session", sessionStatus);
  await status("rasterprobe.frame", frameStatus);
  await status("rasterprobe.input", inputStatus);
  await expose.element("rasterprobe.raster", element);

  await bridge.runtime.textSize.on((next) => {
    // default: as at the start, an unknown text size is factor 1.
    factor = next ?? 1;
    measure();
    send({ operation: "textSize", factor }).catch((error) => report(`textSize: ${error.message}`));
  });
  new view.ResizeObserver(measure).observe(element);
  measure();
}
