// The exposure port of the provider probe view: registrations, replies and watched status values go through the view bridge.

/** The port that createExpose takes, made from the view bridge. */
export function providerExposurePort(bridge) {
  return {
    register: bridge.exposure.register,
    reply: bridge.exposure.reply,
    changed: bridge.exposure.changed,
    report: (text) => bridge.runtime.error("probeprovider exposure", text),
    onRequest: (answer) => bridge.runtime.native.on("exposure-request", answer),
  };
}
