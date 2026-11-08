// The view of the raster probe: one image region that the fake persistent sidecar @sok-check/sidecar-rasterprobe draws
// (docs/spec/native-surfaces.md#image-regions, docs/spec/persistent-services.md). The view opens the session of its surface with its
// image, forwards the text size factor of the surface and the input of the region to the sidecar, opens the session again on each
// connection notice of the sidecar, and reports the view, the session, the last frame and the input of the region as statuses. A
// hide, a show and a reload of the view are the host's: the host detaches the image of a reloaded page and the new page opens the
// same session again, so the view keeps no state of its own.

export const SIDECAR = "@sok-check/sidecar-rasterprobe";
export const REGION = "raster";

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
  const inputStatus = statusCell({ focused: false, transactions: 0, preedit: null, actions: [], errors: [] });

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

  const answer = (body) => {
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
      case "input":
        return;
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

  const composition = await bridge.composition.create({ regions: { [REGION]: element }, overlays: {} });
  const image = composition.region(REGION);
  image.on("input", (event) => {
    const previous = inputStatus.read();
    inputStatus.set({
      focused: previous.focused,
      transactions: previous.transactions + 1,
      preedit: event.preedit ?? null,
      actions: event.actions ?? [],
      errors: event.errors ?? [],
    });
    // default: an input event that names no correlation identifier continues no input of the native layer.
    send({ operation: "input", actions: event.actions ?? [], preedit: event.preedit ?? null }, event.cids ?? [])
      .catch((error) => report(`input: ${error.message}`));
  });
  image.on("focus", (event) => inputStatus.set({ ...inputStatus.read(), focused: event.focused === true }));
  image.on("compose", (event) => inputStatus.set({ ...inputStatus.read(), preedit: event }));
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
  await command("rasterprobe.close", () => send({ operation: "close" }));
  await command("rasterprobe.kill", () => send({ operation: "kill" }));
  const status = (name, cell) => expose.status(name, cell.read, cell.subscribe);
  await status("rasterprobe.view", viewStatus);
  await status("rasterprobe.session", sessionStatus);
  await status("rasterprobe.frame", frameStatus);
  await status("rasterprobe.input", inputStatus);

  await bridge.runtime.textSize.on((next) => {
    // default: as at the start, an unknown text size is factor 1.
    factor = next ?? 1;
    measure();
    send({ operation: "textSize", factor }).catch((error) => report(`textSize: ${error.message}`));
  });
  new view.ResizeObserver(measure).observe(element);
  measure();
  await open();
}
