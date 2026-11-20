// The view of the agent probe (docs/spec/cli.md#acting-on-a-layout): in the place of a process plugin, it asks its fixture sidecar
// @sok-check/sidecar-agentprobe (e2e/fixtures/sidecars/agentprobe) to start for its surface a process that writes its
// SOKSAK_CONFIG_DIR and runs `sok context` (docs/spec/sidecars.md#processes-of-a-surface), and it reports what
// the process wrote as the status agentprobe.process. An error of the sidecar is reported to the application log and kept in the
// status.

/** The npm name of the fixture sidecar of the probe. */
export const SIDECAR = "@sok-check/sidecar-agentprobe";

/** The exposure port of the probe view: registrations, replies and watched status values go through the view bridge. */
export function probeExposurePort(bridge) {
  return {
    register: bridge.exposure.register,
    reply: bridge.exposure.reply,
    changed: bridge.exposure.changed,
    report: (text) => bridge.runtime.error("agentprobe exposure", text),
    onRequest: (answer) => bridge.runtime.native.on("exposure-request", answer),
  };
}

/** Starts the probe. bridge is the view bridge, expose the exposure of the page and view the window of the view (its sokSurface). */
export async function startAgentProbe({ bridge, expose, view }) {
  const surface = view.sokSurface.surface;
  const sidecar = bridge.runtime.sidecar(SIDECAR);
  let current = null;
  const listeners = new Set();
  const set = (value) => {
    current = value;
    for (const listener of listeners) listener(current);
  };
  const fail = (text) => {
    set({ error: text });
    bridge.runtime.error("agentprobe", text);
  };
  await sidecar.on(surface, (body) => {
    if (body?.event === "process") {
      const { configDirectory, context } = body;
      set({ configDirectory, context });
    } else if (typeof body?.error === "string") {
      fail(body.error);
    } else {
      fail(`the sidecar sent an unknown message ${JSON.stringify(body)}`);
    }
  });
  await sidecar.onFailure(surface, (reason) => fail(`the sidecar failed: ${reason}`));
  await bridge.commands.register("agentprobe.start", async ({ sok }) => {
    if (typeof sok !== "string" || sok === "") throw new Error(`agentprobe.start needs sok, the path of a sok program, not ${JSON.stringify(sok)}`);
    await sidecar.send(surface, { operation: "start", sok });
    return null;
  });
  await expose.status("agentprobe.process", () => current, (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
}
