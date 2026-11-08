// The views of the layout probe, a core fixture that stands in for real plugins in the layout checks of core
// (docs/spec/plugin-processes.md#verification-boundaries). The tab view reports what core gives a view (its start values, its tab
// reports, its size and theme, the document region and the settings of the plugin) through the statuses layoutprobe.view,
// layoutprobe.surface and layoutprobe.document, and runs the tab reports and the document changes as commands. A section view
// reports its section and size as layoutprobe.section; the follow section follows the surface that core.sidebars reports for it
// (docs/spec/plugins.md#sections). Both views run core.file.open from themselves as layoutprobe.open. The module imports nothing, so the owner test runs it with a fake bridge.

/** The footer text that the tab view declares at its start (docs/spec/plugins.md#tab-reports). */
export const FOOTER = "Layout probe";
/** The plugin of the probe, whose surfaces the follow section follows. */
export const PLUGIN = "layoutprobe";
/** The section that follows the surface of core.sidebars. */
export const FOLLOW_SECTION = "layoutprobe.follow";
/** The marks of the messages between the view and its region document, which both receive every message of the document window. */
export const TO_DOCUMENT = "layoutprobe.document";
export const FROM_DOCUMENT = "layoutprobe.document";

/** The plugin document of the region of the tab with surface id surface; the key keeps the site data of each tab apart. */
export function documentAddress(surface) {
  return `soksak://${PLUGIN}/ui/document.html?key=${encodeURIComponent(surface)}`;
}

/**
 * The visibility of the region document: hidden while the view is hidden (its tab or its section is not shown), occluded while the
 * view is shown and the document is hidden, because a view keeps its document visible in a covered window and a region does not
 * (docs/spec/native-surfaces.md#document-regions), and shown otherwise; null before the document reported.
 */
export function regionVisibility(view, document) {
  if (view === "hidden") return "hidden";
  if (document === null) return null;
  return document === "hidden" ? "occluded" : "shown";
}

/** The surface that core.sidebars reports for the section surface sectionSurface, or null when no drawn sidebar holds it. */
export function followedSurface(sidebars, sectionSurface) {
  // default: core.sidebars is null until the main page reports it, and a sidebar without sections holds none.
  for (const sidebar of sidebars ?? []) for (const section of sidebar.sections ?? []) {
    if (section.surfaceId === sectionSurface) return section.surface ?? null;
  }
  return null;
}

/**
 * Runs core.file.open {path} from a view through its bridge and answers `{tab, error}`: the tab that the command opened or
 * activated, or the message of its failure, which the view receives itself instead of rethrowing it.
 */
export async function openFile(bridge, { path }) {
  if (typeof path !== "string" || path === "") throw new TypeError("layoutprobe.open requires a path");
  try {
    const result = await bridge.runtime.command("core.file.open", { path });
    // default: a reply without a tab names no opened tab.
    return { tab: result?.tab ?? null, error: null };
  } catch (error) {
    return { tab: null, error: error?.message ?? String(error) };
  }
}

/** A status value with its listeners: read, subscribe for createExpose, and set, which merges a change and notifies. */
function createState(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    read: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(change) {
      value = { ...value, ...change };
      for (const listener of listeners) listener(value);
    },
  };
}

/** The size, scale, region rectangle, visibility and theme of the tab view. */
function readSurface(view, element) {
  const rect = element.getBoundingClientRect();
  // default: a view without a start theme fails createViewBridge, so an empty colorScheme only precedes the bridge.
  const scheme = view.document.documentElement.style.colorScheme || null;
  return {
    width: view.innerWidth, height: view.innerHeight, scale: view.devicePixelRatio,
    region: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    visibility: view.document.visibilityState,
    theme: { scheme, background: view.getComputedStyle(view.document.body).backgroundColor },
  };
}

/** Starts the tab view: bridge is the view bridge, expose the exposure of the view, view the window of the page. */
export async function startLayoutProbe({ bridge, expose, view }) {
  const { surface, params, origin, project } = view.sokSurface;
  const element = view.document.getElementById("document");
  const address = documentAddress(surface);
  // A surface starts in origin.directory, otherwise in the project root (docs/spec/plugins.md#tab-reports); the account's home is
  // not known to a view, so it is null here.
  // default: a tab without params has no path, and a window without a project has no root.
  const tab = createState({
    surface, params, path: params?.path ?? null, origin, project,
    directory: origin.directory ?? project?.root ?? null,
    settings: null, title: null, footer: FOOTER, reported: null, notice: null,
  });
  const size = createState(readSurface(view, element));
  const region = createState({
    url: address, reported: false, scheme: null, document: null,
    visibility: regionVisibility(view.document.visibilityState, null), stored: null, color: null,
  });
  const resized = () => size.set(readSurface(view, element));
  view.addEventListener("resize", resized);
  view.document.addEventListener("visibilitychange", () => {
    resized();
    region.set({ visibility: regionVisibility(view.document.visibilityState, region.read().document) });
  });
  // The bridge applies each theme to the root before it calls the listeners, so the read sees the new theme.
  bridge.runtime.theme(resized);

  await expose.status("layoutprobe.view", tab.read, tab.subscribe);
  await expose.status("layoutprobe.surface", size.read, size.subscribe);
  await expose.status("layoutprobe.document", region.read, region.subscribe);
  await bridge.calls.request("tab.footer", FOOTER);
  tab.set({ settings: await bridge.runtime.settings.read() });
  await bridge.runtime.settings.on((settings) => tab.set({ settings }));

  const composition = await bridge.composition.create({ regions: { page: element }, overlays: {} });
  const page = composition.region("page");
  page.onMessage((message) => {
    if (message?.from !== FROM_DOCUMENT) return;
    region.set({
      reported: true, scheme: message.scheme, document: message.visibility,
      visibility: regionVisibility(view.document.visibilityState, message.visibility),
      stored: message.stored, color: message.color,
    });
  });

  // Each tab report runs the view call of the surface and then records the value that the call accepted.
  const report = (call, field) => async (value) => {
    await bridge.calls.request(call, value);
    tab.set({ [field]: value });
    return null;
  };
  const title = report("tab.title", "title");
  const footer = report("tab.footer", "footer");
  const directory = report("tab.directory", "reported");
  await bridge.commands.register("layoutprobe.title", ({ text }) => title(text));
  await bridge.commands.register("layoutprobe.footer", ({ text }) => footer(text));
  await bridge.commands.register("layoutprobe.directory", ({ path }) => directory(path));
  // default: an omitted policy is tab, as for tab.notify (docs/spec/plugins.md#tab-reports).
  await bridge.commands.register("layoutprobe.notify", async ({ text, policy = "tab" }) => {
    await bridge.calls.request("tab.notify", { text, policy });
    tab.set({ notice: { text, policy } });
    return null;
  });
  await bridge.commands.register("layoutprobe.document.color", async ({ color }) => {
    if (typeof color !== "string" || color === "") throw new TypeError("layoutprobe.document.color requires a color");
    await page.post({ to: TO_DOCUMENT, color });
    return null;
  });
  await bridge.commands.register("layoutprobe.open", (params) => openFile(bridge, params));
  await bridge.commands.register("layoutprobe.document.store", async ({ value }) => {
    if (typeof value !== "string") throw new TypeError("layoutprobe.document.store requires a string value");
    await page.post({ to: TO_DOCUMENT, store: value });
    return null;
  });

  await page.load(address);
}

/** Starts a section view: the status layoutprobe.section, and for the follow section the view of the surface that it follows. */
export async function startProbeSection({ bridge, expose, view }) {
  const { surface, section } = view.sokSurface;
  const follows = section.id === FOLLOW_SECTION;
  const state = createState({
    id: section.id, sidebar: section.sidebar, card: section.card,
    width: view.innerWidth, height: view.innerHeight, follows, surface: null, view: null,
  });
  view.addEventListener("resize", () => state.set({ width: view.innerWidth, height: view.innerHeight }));
  await expose.status("layoutprobe.section", state.read, state.subscribe);
  await bridge.commands.register("layoutprobe.open", (params) => openFile(bridge, params));
  if (!follows) return;
  // A view watches a status on a surface of its own plugin only, so the section watches layoutprobe.view only on a followed surface
  // that core.surfaces names as a layoutprobe surface; for another plugin's tab it reports the surface with no view.
  let followed = null;
  let surfaces = [];
  let watched = null;
  let stop = null;
  const follow = () => {
    const entry = surfaces.find((candidate) => candidate.surface === followed);
    const target = entry?.plugin === PLUGIN ? followed : null;
    if (target === watched) return;
    stop?.();
    stop = null;
    watched = target;
    state.set({ view: null });
    if (target !== null) stop = bridge.runtime.status.watch("layoutprobe.view", (value) => state.set({ view: value }), { surface: target });
  };
  bridge.runtime.status.watch("core.surfaces", (value) => {
    // default: core.surfaces is null until the main page reports it.
    surfaces = value ?? [];
    follow();
  });
  bridge.runtime.status.watch("core.sidebars", (value) => {
    followed = followedSurface(value, surface);
    state.set({ surface: followed });
    follow();
  });
}
