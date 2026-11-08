// The input fixtures in the window checks. They carry the input checks of core in place of a real plugin
// (docs/spec/plugin-processes.md#verification-boundaries):
// - the input probe (e2e/fixtures/input-probe/probe): its statuses `probeinput.field` and `probeinput.document` report the keys,
//   preedit, commits, caret, copies, pastes, wheels and pointer gestures that reach the text field of its view and the text field
//   of its native document region, and `probeinput.routing` the Escape that the view forwards;
// - the raster probe (e2e/fixtures/raster-probe/probe): its image region takes native input through the input client of core, and
//   `rasterprobe.input` logs each input transaction of the region with the echo of the sidecar that received it.
import { isDeepStrictEqual } from "node:util";

/** The plugin id of the input probe. */
export const INPUT_PROBE = "probeinput";

/** The entries that a probe tab registers before a check reads it. */
export const INPUT_PROBE_ENTRIES = Object.freeze(["status probeinput.field", "status probeinput.document", "status probeinput.routing",
  "command probeinput.clear", "command probeinput.select", "command probeinput.clock", "element probeinput.field", "element probeinput.text"]);

/** The card of the focused card of the grid, or the first card that holds tabs. */
export function focusedCard(grid) {
  // default: a layout without a focused card adds the probe to the first card that holds tabs.
  const card = grid?.cards?.find((item) => item.focused) ?? grid?.cards?.find((item) => !item.fixed && item.tabs?.length);
  if (!card) throw new Error(`the layout has no card for an input probe tab: ${JSON.stringify(grid?.cards ?? null)}`);
  return card;
}

/**
 * Waits until the probe tab `surface` registered INPUT_PROBE_ENTRIES and the document of its native region has loaded and
 * reported, and returns `surface`.
 */
export async function readyInputProbe(s, surface) {
  await s.registered(surface, INPUT_PROBE_ENTRIES);
  await s.until("probeinput.document", (state) => state.ready === true, `the document region of the input probe ${surface} did not load`,
    { surface });
  return surface;
}

/**
 * Adds a tab of the input probe to `card` (by default the focused card), waits until it is ready (readyInputProbe), and returns
 * `{surface, card}`.
 */
export async function inputProbeTab(s, { card } = {}) {
  const id = card ?? focusedCard(await s.get("core.grid")).id;
  const { tab } = await s.run("core.card.add-tab", { card: id, plugin: INPUT_PROBE });
  await s.until("core.surfaces", (list) => list.some((item) => item.surface === tab && item.visible && item.status?.phase === "ready"),
    `the input probe tab ${tab} did not become ready`);
  await readyInputProbe(s, tab);
  return { surface: tab, card: id };
}

/** The centre of the element `name` of the probe `surface` in window coordinates. */
async function centre(s, name, surface) {
  const rect = await s.rect(name, undefined, surface);
  if (!(rect.width > 0 && rect.height > 0)) throw new Error(`the element ${name} of ${surface} has no area: ${JSON.stringify(rect)}`);
  return { x: rect.document.x + rect.x + rect.width / 2, y: rect.document.y + rect.y + rect.height / 2 };
}

/** The centre of the view text field of the probe `surface` in window coordinates. */
export const fieldPoint = (s, surface) => centre(s, "probeinput.field", surface);

/** The centre of the native document region of the probe `surface` in window coordinates; its text field fills the region. */
export const documentPoint = (s, surface) => centre(s, "probeinput.text", surface);

/** Whether `host.window` reports the document region of `surface` as holding the native keyboard. */
export const documentFocused = (window, surface) => window.documents.some((item) => item.surface === surface && item.focused);

/** Presses each character of `text` with that text stated, and a space as Space. */
export async function typeText(s, text) {
  for (const ch of text) await s.press(ch === " " ? "Space" : ch, { text: ch });
}

/**
 * Sends a key down and a key up of each character of `text` with its text stated, a space as Space and `\n` as Enter without
 * text, without waiting for anything between the keys.
 */
export async function sendText(s, text) {
  for (const ch of text) {
    const [name, options] = ch === "\n" ? ["Enter", {}] : [ch === " " ? "Space" : ch, { text: ch }];
    await s.key(name, "down", options);
    await s.key(name, "up", options);
  }
}

/** The plugin id of the raster probe (e2e/fixtures/raster-probe/probe), whose image region takes native input. */
export const RASTER_PROBE = "rasterprobe";

/** The name of the image region of the raster probe. */
export const RASTER_REGION = "raster";

/** The entries that a raster probe tab registers before a check reads its input. */
export const RASTER_PROBE_ENTRIES = Object.freeze(["status rasterprobe.session", "status rasterprobe.frame", "status rasterprobe.input",
  "command rasterprobe.focus", "command rasterprobe.input.clear"]);

/** The image region row of the raster probe `surface` in `host.window`, or undefined. */
export const imageRegion = (window, surface) => window.regions.find((item) => item.surface === surface && item.name === RASTER_REGION);

/** Whether `host.window` reports the image region of the raster probe `surface` as holding the native keyboard. */
export const imageFocused = (window, surface) => imageRegion(window, surface)?.focused === true;

/**
 * Waits until the raster probe tab `surface` registered RASTER_PROBE_ENTRIES, its session is open, its image region drew a frame and
 * `host.window` shows the region with a frame, and returns that row of `host.window.regions`.
 */
export async function readyRasterProbe(s, surface) {
  await s.registered(surface, RASTER_PROBE_ENTRIES);
  await s.until("rasterprobe.session", (state) => state.connected && state.session !== null,
    `the raster probe ${surface} did not open its session`, { surface });
  await s.until("rasterprobe.frame", (frame) => frame !== null, `the raster probe ${surface} drew no frame`, { surface });
  const window = await s.until("host.window", (value) => imageRegion(value, surface)?.visible === true
    && imageRegion(value, surface).frame?.width > 0, `the image region of ${surface} is not shown`);
  return imageRegion(window, surface);
}

/**
 * Adds a tab of the raster probe to `card` (by default the focused card), or with `split` puts it in a new card on that side of
 * the card, waits until it is ready (readyRasterProbe), and returns `{surface, card}` with the card that holds it.
 */
export async function rasterProbeTab(s, { card, split } = {}) {
  const id = card ?? focusedCard(await s.get("core.grid")).id;
  const { tab } = split === undefined ? await s.run("core.card.add-tab", { card: id, plugin: RASTER_PROBE })
    : await s.run("core.card.split", { card: id, side: split, plugin: RASTER_PROBE });
  await s.until("core.surfaces", (list) => list.some((item) => item.surface === tab && item.visible && item.status?.phase === "ready"),
    `the raster probe tab ${tab} did not become ready`);
  await readyRasterProbe(s, tab);
  const holder = (await s.get("core.grid")).cards.find((item) => item.tabs?.some((entry) => entry.id === tab));
  return { surface: tab, card: holder.id };
}

/** The image region of the raster probe `surface` as a rectangle in the shape of `element.rect`, in window coordinates. */
export async function imageRect(s, surface) {
  const region = imageRegion(await s.get("host.window"), surface);
  if (!region?.frame) throw new Error(`the image region of ${surface} has no frame`);
  const { x, y, width, height } = region.frame;
  return { x, y, width, height, document: { x: 0, y: 0 } };
}

/** The centre of the image region of the raster probe `surface` in window coordinates. */
export async function imagePoint(s, surface) {
  const rect = await imageRect(s, surface);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** The transactions of the input log of the raster probe `surface` (`rasterprobe.input`) after the transaction `after`. */
export async function inputLog(s, surface, after = 0) {
  return (await s.get("rasterprobe.input", surface)).log.filter((entry) => entry.sequence > after);
}

/** The sequence of the last transaction of the input log of the raster probe `surface`. */
export const lastTransaction = async (s, surface) => (await s.get("rasterprobe.input", surface)).log.at(-1)?.sequence ?? 0;

/**
 * The text that the actions of `transactions` typed, in order: the text of each insert and of each character key, and `\n` for
 * each Enter key or newline command.
 */
export function typedText(transactions) {
  return transactions.flatMap((entry) => entry.actions).map((action) => {
    if (action.type === "insert" || (action.type === "key" && action.key === "Char")) return action.text;
    if ((action.type === "key" && action.key === "Enter") || (action.type === "command" && action.selector === "insertNewline:")) return "\n";
    return "";
  }).join("");
}

/**
 * Checks that the sidecar of the raster probe received each transaction of `transactions` once and unchanged: its echo carries the
 * sequence, the actions and the preedit of the transaction. Fails on an empty list, so a check never passes without input.
 */
export function assertReceivedUnchanged(transactions, label) {
  if (transactions.length === 0) throw new Error(`${label}: the image region reported no input transaction`);
  for (const entry of transactions) {
    if (entry.errors.length > 0) throw new Error(`${label}: transaction ${entry.sequence} failed: ${JSON.stringify(entry.errors)}`);
    const expected = { operation: "input", sequence: entry.sequence, actions: entry.actions, preedit: entry.preedit };
    if (!isDeepStrictEqual(entry.received, expected)) {
      throw new Error(`${label}: the sidecar did not receive transaction ${entry.sequence} unchanged: ${JSON.stringify(entry)}`);
    }
  }
}

/** The text of the insert actions of `transactions`, joined in order: what the input client committed. */
export const insertedText = (transactions) => transactions.flatMap((entry) => entry.actions)
  .filter((action) => action.type === "insert").map((action) => action.text).join("");

/**
 * The document that `transactions` of an image region leave in a plain text client, as the AppKit reference holds it: the typed
 * text (typedText), less one character for each Backspace key or deleteBackward: command outside a composition, followed by the
 * preedit of the last transaction.
 */
export function inputDocument(transactions) {
  let committed = "";
  for (const action of transactions.flatMap((entry) => entry.actions)) {
    if ((action.type === "key" && action.key === "Backspace") || (action.type === "command" && action.selector === "deleteBackward:")) {
      committed = [...committed].slice(0, -1).join("");
    } else committed += typedText([{ actions: [action] }]);
  }
  // default: a log without a transaction has no preedit.
  return committed + (transactions.at(-1)?.preedit?.text ?? "");
}

/**
 * Whether the transaction acknowledges the key: `k` as a character key, an insert of visible text or a preedit without actions;
 * `Backspace` as its key or the deleteBackward: command; `Space` as its key, a character key with a space or an insert with a space.
 */
export function transactionMatchesKey(transaction, key) {
  const { actions } = transaction;
  if (key === "k") {
    if (actions.some((action) => action.type === "command" || (action.type === "key" && !(action.key === "Char" && action.text === key)))) {
      return false;
    }
    return actions.some((action) => (action.type === "key" && action.key === "Char" && action.text === key)
      || (action.type === "insert" && action.text.trim().length > 0)) || (actions.length === 0 && transaction.preedit.text.length > 0);
  }
  if (key === "Backspace") {
    return actions.some((action) => (action.type === "key" && action.key === key) || (action.type === "command" && action.selector === "deleteBackward:"));
  }
  if (key === "Space") {
    return actions.some((action) => (action.type === "key" && (action.key === key || (action.key === "Char" && action.text.includes(" "))))
      || (action.type === "insert" && action.text.includes(" ")));
  }
  throw new Error(`no receipt rule for the key ${JSON.stringify(key)}`);
}

/**
 * Waits until the transactions of the raster probe `surface` after `after` leave `expected` as their document (inputDocument) and
 * returns them.
 */
export async function untilDocument(s, surface, after, expected, message) {
  const state = await s.until("rasterprobe.input", (value) => inputDocument(value.log.filter((entry) => entry.sequence > after)) === expected,
    message, { surface });
  return state.log.filter((entry) => entry.sequence > after);
}

/**
 * Gives the native keyboard of the active key window to the image region of the raster probe `surface` as a person does: the window
 * moves away from the pointer, the check activates the application with a move over the region and presses it, and the probe focuses
 * its region. The input methods of the system serve only the key window of the active application
 * (docs/spec/exposure.md#virtual-key-window).
 */
export async function focusImageActive(s, surface) {
  await s.keepPointerOutside();
  const point = await imagePoint(s, surface);
  await s.pointer(point.x, point.y, "move", { activate: true });
  await s.click(point.x, point.y);
  await s.run("rasterprobe.focus", {}, surface);
  await s.until("host.window", (host) => host.active === true && host.key === true && imageFocused(host, surface)
    && host.responder?.surface === surface, "the image region did not become the focused view of the active key window");
  await s.until("rasterprobe.input", (input) => input.focused, "the image region did not report its focus", { surface });
}

/**
 * Waits until the input log of the raster probe `surface` holds a transaction after `after` and the sidecar echoed every such
 * transaction, then returns them.
 */
export async function receivedAfter(s, surface, after, message) {
  const state = await s.until("rasterprobe.input", (value) => {
    const entries = value.log.filter((entry) => entry.sequence > after);
    return entries.length > 0 && entries.every((entry) => entry.received !== null);
  }, message, { surface });
  return state.log.filter((entry) => entry.sequence > after);
}
