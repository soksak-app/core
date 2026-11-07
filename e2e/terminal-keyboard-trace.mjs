// A short input transaction fits the existing bounded plugin trace. This is
// diagnostic evidence; neither trace nor status substitutes for command output.
export async function traceTerminalInput(test, session, surface, label, work, nativeReceipts) {
  await session.run("terminal.ime.trace", { action: "start" }, surface);
  let failure;
  try {
    return await work();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const evidence = async (name, read) => {
      try { test.diagnostic(`${label} ${name}: ${JSON.stringify(await read())}`); }
      catch (error) {
        test.diagnostic(`${label} ${name} evidence failed: ${error.stack ?? error}`);
        if (!failure) throw error;
      }
    };
    await evidence("terminal.ime.trace", () => session.run("terminal.ime.trace", { action: "stop" }, surface));
    if (failure) {
      await evidence("host.window", () => session.get("host.window"));
      await evidence("core.surface.input", () => session.get("core.surface.input", surface));
      await evidence("terminal.session", () => session.get("terminal.session", surface));
      await evidence("terminal.pty.pending", () => session.run("terminal.pty.pending", {}, surface));
      // One post-failure engine snapshot distinguishes stale watched state
      // from missing output. It never retries the failed condition or changes it.
      await evidence("terminal.screen.read after failure", () => session.run("terminal.screen.read", {}, surface));
      await evidence("terminal.screen after failure", () => session.get("terminal.screen", surface));
      if (nativeReceipts) await evidence("native.input.key_down", nativeReceipts);
    }
  }
}
