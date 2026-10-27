// The declared exposure uses a qualified name; snapshot messages use the plugin-local key.
export async function startRafProbe({ bridge, requestAnimationFrame, performance }) {
  const status = "probehostraf.sample";
  const snapshotStatus = "sample";
  let frames = 0;
  const started = performance.now();

  function countFrame() {
    frames++;
    requestAnimationFrame(countFrame);
  }

  function readSample() {
    return { frames, performanceNow: performance.now(), timeOrigin: performance.timeOrigin };
  }

  requestAnimationFrame(countFrame);
  await bridge.exposure.register("status", status);
  await bridge.commands.register("probehostraf.read", () => {
    const sample = readSample();
    bridge.snapshots.push(snapshotStatus, sample);
    return sample;
  });
  bridge.snapshots.push(snapshotStatus, { frames, performanceNow: started, timeOrigin: performance.timeOrigin });
}
