/** Prepares the default terminal surface and waits until its session has started. */
export async function prepareTerminal(client, request, { startupLimit = 15_000 } = {}) {
  let surfaces = await request(client, "status.get", { window: "main", name: "core.surfaces" });
  let surface = surfaces.find((item) => item.plugin === "terminal" && item.visible)?.surface;
  if (!surface) {
    await request(client, "diagnostics.fixture", { window: "main", settings: {} });
    const grid = await request(client, "status.get", { window: "main", name: "core.grid" });
    const terminal = grid.cards.flatMap((card) => card.tabs).find((tab) => tab.plugin === "terminal");
    if (!terminal) throw new Error("shutdown fixture has no terminal tab");
    await request(client, "command.run", { window: "main", name: "core.tab.select", params: { tab: terminal.id } });
  }
  surfaces = await client.watch("main", "core.surfaces",
    (value) => value.some((item) => item.plugin === "terminal" && item.visible), { timeout: startupLimit });
  surface = surfaces.find((item) => item.plugin === "terminal" && item.visible)?.surface;
  if (!surface) throw new Error("shutdown fixture terminal did not become visible");
  await request(client, "command.run", {
    window: "main", name: "terminal.input",
    surface,
    params: { bytes: "printf '\\033[?1002h\\033[?1006hSHUTDOWN-READY\\n'\r" },
  });
  const session = await client.watch("main", "terminal.session",
    (value) => value?.sessionId && value.error === undefined, { surface, timeout: startupLimit });
  return { surface, sessionId: session.sessionId };
}
