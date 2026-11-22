// The owned sessions of the main page (docs/spec/plugins.md#owned-sessions, docs/spec/persistent-services.md#owned-session-messages).
// A surface of a plugin with the member sessions opens a session that the persistent sidecar of the plugin holds. The page keeps one
// entry per open session: its plugin, its owner surface, the tab that shows it, and its sidecar. The entries are the status
// core.sessions; the sidecar holds the sessions themselves.
import { plugin, hasPlugin, plugins } from "./registry.js";
import { sidecarSessions, windowSidecar, report } from "./host.js";
import { emitEvent } from "./page-log.js";
import { onTabsClosed } from "./closed-tabs.js";
import { all as allProjects, waitForInitialProjectContext } from "./projects.js";

/** The open sessions of this page, keyed by session identifier, in the order that they opened. */
const sessions = new Map();

/** The listener of each owner surface that has an open session: its stop function, once the host answered, and whether it was dropped. */
const listens = new Map();

const SIZE_REFUSAL = "size width, height and scale must be positive numbers";
const isPositive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Whether a size is {width, height, scale} with positive numbers, the points of the card and the backing scale (docs/spec/plugins.md#owned-sessions). */
const isSize = (size) => size !== null && typeof size === "object" && isPositive(size.width) && isPositive(size.height) && isPositive(size.scale);

/** The members of a size, as the request body states them; no other member is sent to the sidecar. */
const sizeBody = ({ width, height, scale }) => ({ width, height, scale });

const sameSize = (a, b) => Boolean(a && b) && a.width === b.width && a.height === b.height && a.scale === b.scale;

function requireSession(session) {
  const entry = sessions.get(session);
  if (!entry) throw new Error(`session ${session} is not open`);
  return entry;
}

/** The failure that a sidecar reply states, or null: a refusal that states its rule and reason, as the input guard of the sidecar does,
 * keeps them in the text, so the person reads why the request was refused. */
export function ownedReplyFailure(where, reply) {
  if (reply?.error === undefined) return null;
  const parts = [reply.error, reply.rule, reply.reason].filter((part) => part !== undefined && part !== "");
  return new Error(`${where}: ${parts.join(": ")}`);
}

/** The reply of a sidecar request that names the session: a failed reply states its error, and any other reply must name the session. */
function sessionReply(where, reply, session) {
  const failure = ownedReplyFailure(where, reply);
  if (failure) throw failure;
  if (reply?.session !== session) throw new Error(`${where}: the sidecar reply names no session ${session}`);
  return reply;
}

const PROGRAM_STATES = ["idle", "working", "blocked"];

/** The status core.sessions: each open session with its plugin, owner surface, showing tab (or null) and program state (or null). */
export const ownedSessionsState = () => [...sessions.values()].map(({ session, plugin: id, owner, shownBy, program }) =>
  ({ session, plugin: id, owner, shownBy, program }));

/**
 * core.session.open: the caller surface opens a session of its plugin with the size and the params. The page names the session with a
 * creation identifier, so the sidecar returns the same session for a repeated request. Resolves with {session}.
 */
export async function openOwnedSession({ plugin: id, params, size }, surface) {
  if (!hasPlugin(id)) throw new Error(`plugin ${id} is not loaded`);
  const sidecar = plugin(id).sessions;
  if (!sidecar) throw new Error(`plugin ${id} declares no sessions`);
  if (surface === undefined) throw new Error("core.session.open requires the surface of its caller");
  if (!isSize(size)) throw new Error(SIZE_REFUSAL);
  const creation = crypto.randomUUID();
  const port = windowSidecar(sidecar);
  if (!port) throw new Error(`owned session sidecar unavailable: ${sidecar}`);
  // default: an open without params sends null, the value of an absent parameter set.
  const reply = await port.send(surface, { operation: "open", session: { creation }, size: sizeBody(size), params: params ?? null });
  const failure = ownedReplyFailure("core.session.open", reply);
  if (failure) throw failure;
  if (typeof reply?.session !== "string" || reply.session === "" || reply.creation !== creation) {
    throw new Error(`core.session.open: the sidecar reply names no session of creation ${creation}`);
  }
  sessions.set(reply.session, { session: reply.session, plugin: id, owner: surface, shownBy: null, program: null, sidecar, size: sizeBody(size), pending: null });
  listenOwner(surface, port);
  emitEvent("info", "workbench.session.open", { session: reply.session, plugin: id, owner: surface, size: sizeBody(size) });
  return { session: reply.session };
}

/**
 * core.session.resize: while no tab shows the session only its owner may resize it; a shown session takes the size of its tab from
 * any surface. The request goes to the sidecar under the owner surface.
 */
export async function resizeOwnedSession({ session, size }, surface) {
  const entry = requireSession(session);
  if (surface === undefined) throw new Error("core.session.resize requires the surface of its caller");
  if (entry.shownBy === null && surface !== entry.owner) throw new Error(`surface ${surface} does not own session ${session}`);
  if (!isSize(size)) throw new Error(SIZE_REFUSAL);
  await sendSize(entry, sizeBody(size));
  return { session, size: entry.size };
}

/**
 * Sends the size of a session to its sidecar under the owner surface, and records it as the size of the session when the sidecar
 * answers with the same size (docs/spec/persistent-services.md#owned-session-messages).
 */
async function sendSize(entry, size) {
  const { session } = entry;
  const reply = sessionReply("core.session.resize", await windowSidecar(entry.sidecar).send(entry.owner, { operation: "resize", session, size }), session);
  if (!sameSize(reply.size, size)) throw new Error(`core.session.resize: the sidecar reply names another size for session ${session}`);
  if (sessions.get(session) === entry) entry.size = size;
}

/**
 * Sizes a session to the frame of its card. A session that already has the size, or a session with a resize of that size pending,
 * sends nothing; any other size sends one resize, and the pending size is cleared when the sidecar answers.
 */
function sizeToCard(entry, card) {
  const size = sizeBody(card);
  if (sameSize(entry.size, size) || sameSize(entry.pending, size)) return;
  entry.pending = size;
  sendSize(entry, size)
    // default: an error that is not an Error object is reported by its value.
    .catch((error) => report(`core.session.resize ${entry.session}: ${error?.message ?? error}`))
    .finally(() => {
      if (entry.pending === size) entry.pending = null;
    });
}

/**
 * The frame of the card of a tab changed: each session that the tab shows takes the new size of the card, in points and at the backing
 * scale of the window. The page calls it for a changed frame only; it does no work for a frame of the same size.
 */
export function cardFrameChanged(tab, card) {
  if (card === null) return;
  if (!isSize(card)) {
    report(`core.session.resize: ${SIZE_REFUSAL}`);
    return;
  }
  for (const entry of sessions.values()) if (entry.shownBy === tab) sizeToCard(entry, card);
}

/**
 * Runs after each redraw of the plane (onCardFrames of plane.js): each tab that shows a session gets the frame of its card from sizeOf,
 * which answers null for a hidden card. The redraw that changes no frame sends nothing.
 */
export function cardFramesRedrawn(sizeOf) {
  for (const tab of new Set([...sessions.values()].map(({ shownBy }) => shownBy))) {
    if (tab !== null) cardFrameChanged(tab, sizeOf(tab));
  }
}

/** Ends the session with the sidecar and removes its entry. The reason is the one that the event names (docs/spec/plugins.md#owned-sessions). */
async function endEntry(entry, reason) {
  const reply = await windowSidecar(entry.sidecar).send(entry.owner, { operation: "end", session: entry.session });
  sessionReply(`core.session.end (${reason})`, reply, entry.session);
  if (reply.ended !== true) throw new Error(`core.session.end (${reason}): the sidecar did not end session ${entry.session}`);
  sessions.delete(entry.session);
  emitEvent("info", "workbench.session.end", { session: entry.session, reason });
}

/** core.session.end: only the owner ends its session. */
export async function endOwnedSession({ session }, surface) {
  const entry = requireSession(session);
  if (surface !== entry.owner) throw new Error(`surface ${surface} does not own session ${session}`);
  await endEntry(entry, "ended");
  return null;
}

/** The entry of a session whose owner is the caller; any other caller, and a missing caller, is refused before any sidecar request. */
function requireOwner(command, session, surface) {
  const entry = requireSession(session);
  if (surface === undefined) throw new Error(`${command} requires the surface of its caller`);
  if (surface !== entry.owner) throw new Error(`session ${session} is owned by ${entry.owner}`);
  return entry;
}

/** A request of an owner command: the sidecar reply must name the session, and a failed reply states its error. */
const ownerRequest = (entry, body, where) => windowSidecar(entry.sidecar).send(entry.owner, body).then((reply) => sessionReply(where, reply, entry.session));

/** core.session.input: the owner types text into its session as given. */
export async function inputOwnedSession({ session, text }, surface) {
  const entry = requireOwner("core.session.input", session, surface);
  if (typeof text !== "string") throw new Error("core.session.input text must be a string");
  await ownerRequest(entry, { operation: "input", session, text }, "core.session.input");
  return {};
}

/** core.session.submit: the owner pastes text into its session and then sends Enter, so the text holds no line end. */
export async function submitOwnedSession({ session, text }, surface) {
  const entry = requireOwner("core.session.submit", session, surface);
  if (typeof text !== "string") throw new Error("core.session.submit text must be a string");
  if (/[\r\n]/.test(text)) throw new Error("core.session.submit text must not contain CR or LF");
  await ownerRequest(entry, { operation: "paste", session, text }, "core.session.submit");
  await ownerRequest(entry, { operation: "input", session, text: "\r" }, "core.session.submit");
  return {};
}

/** core.session.read: the owner reads the screen of its session; the sidecar reply is returned unchanged when it states no error. */
export async function readOwnedSession({ session }, surface) {
  const entry = requireOwner("core.session.read", session, surface);
  const reply = await windowSidecar(entry.sidecar).send(entry.owner, { operation: "read", session });
  const failure = ownedReplyFailure("core.session.read", reply);
  if (failure) throw failure;
  return reply;
}

/**
 * Checks a core.layout.open that names a session: the session is open, belongs to the plugin of the tab, and is not shown by another
 * open tab. The layout operation then opens or selects the tab, and bindShown records the tab that shows the session.
 */
export function checkShowOwnedSession(session, id) {
  const entry = requireSession(session);
  if (entry.plugin !== id) throw new Error(`session ${session} belongs to plugin ${entry.plugin}, not ${id}`);
  return entry;
}

/**
 * Records that tab shows session and sizes the session to the card of the tab at once. card is the size of the card in points and the
 * scale of the window, or null while the card has no size yet: the first frame of the card then sizes the session (cardFrameChanged).
 */
export function bindShown(session, tab, card = null) {
  const entry = sessions.get(session);
  // A tab that the layout operation did not open or select leaves the session unshown.
  if (entry && (entry.shownBy === null || entry.shownBy === tab)) entry.shownBy = tab;
  else if (entry) throw new Error(`session ${session} is shown by tab ${entry.shownBy}`);
  if (entry && card !== null) {
    if (!isSize(card)) throw new Error(SIZE_REFUSAL);
    sizeToCard(entry, card);
  }
}

/**
 * Listens to the messages of an owner surface while it has an open session, so that its session.ended reaches surfaceMessage
 * (docs/spec/persistent-services.md#owned-sessions). The listener is registered once for each owner.
 */
function listenOwner(owner, port) {
  if (listens.has(owner)) return;
  const entry = { stop: null, dropped: false };
  listens.set(owner, entry);
  port.on(owner, (body) => {
    if (listens.get(owner) === entry) surfaceMessage(owner, body);
  }).then((stop) => {
    entry.stop = stop;
    if (entry.dropped) stop();
  }, (error) => {
    if (listens.get(owner) === entry) listens.delete(owner);
    // default: an error that is not an Error object is reported by its value.
    report(`core.session.ended: listen ${owner}: ${error?.message ?? error}`);
  });
}

/** Removes the listener of an owner surface whose tab closed. A registration that the host has not answered stops when it is answered. */
function unlistenOwner(owner) {
  const entry = listens.get(owner);
  if (!entry) return;
  listens.delete(owner);
  entry.dropped = true;
  // silent: a registration that the host has not answered has no stop function yet, and it stops when it is answered (entry.dropped).
  entry.stop?.();
}

/**
 * Handles a message of an owner surface. A body whose event is session.ended ends the session it names with reason ended, and any other
 * body is a reply or an event of the plugin. An invalid, unknown or foreign end is reported and changes nothing, so a repeated event is
 * refused as an unknown session (docs/spec/persistent-services.md#owned-sessions).
 */
function surfaceMessage(owner, body) {
  if (body !== null && typeof body === "object" && body.event === "session.program") {
    programMessage(owner, body);
    return;
  }
  if (body === null || typeof body !== "object" || body.event !== "session.ended") return;
  const { session } = body;
  if (typeof session !== "string" || session === "") {
    report("core.session.ended: invalid session.ended body: session");
    return;
  }
  if (body.reason !== "ended") {
    report("core.session.ended: invalid session.ended body: reason");
    return;
  }
  const entry = sessions.get(session);
  if (!entry) {
    report(`core.session.ended ${session}: session ${session} is not open`);
    return;
  }
  if (entry.owner !== owner) {
    report(`core.session.ended ${session}: surface ${owner} does not own session ${session}`);
    return;
  }
  sessions.delete(session);
  emitEvent("info", "workbench.session.end", { session, reason: "ended" });
}

/**
 * Handles the event session.program of an owner: it sets the program state of its session, and an invalid, unknown or foreign event is
 * reported and changes nothing (docs/spec/plugins.md#owned-sessions).
 */
function programMessage(owner, body) {
  const { session, state } = body;
  if (typeof session !== "string" || session === "") {
    report("core.session.program: invalid session.program body: session");
    return;
  }
  if (!PROGRAM_STATES.includes(state)) {
    report("core.session.program: invalid session.program body: state");
    return;
  }
  const entry = sessions.get(session);
  if (!entry) {
    report(`core.session.program ${session}: session ${session} is not open`);
    return;
  }
  if (entry.owner !== owner) {
    report(`core.session.program ${session}: surface ${owner} does not own session ${session}`);
    return;
  }
  // A report of the state that the session already has changes nothing and publishes nothing.
  if (entry.program?.state === state) return;
  entry.program = { state };
  emitEvent("info", "workbench.session.program", { session, state });
}

/**
 * A closed tab ends the sessions it owns with reason owner-closed, and a session that it shows is no longer shown. A failed end is
 * reported through the error display, and the session stays in the status until the sidecar ends it.
 */
function tabsClosed(ids) {
  for (const id of ids) unlistenOwner(id);
  for (const entry of sessions.values()) if (ids.includes(entry.shownBy)) entry.shownBy = null;
  for (const entry of [...sessions.values()]) {
    if (!ids.includes(entry.owner)) continue;
    // default: an error that is not an Error object is reported by its value.
    endEntry(entry, "owner-closed").catch((error) => report(`core.session.end ${entry.session}: owner-closed: ${error?.message ?? error}`));
  }
}
onTabsClosed(tabsClosed);

/** The tabs of the stored layouts of every project and space, each with its plugin, as the map of tab identifier to plugin. */
function restoredTabs() {
  const tabs = new Map();
  const walk = (node) => {
    if (node === null || node === undefined) return;
    // default: a node with cut is a split of cards, and the other nodes are cards with their tabs.
    if (node.cut !== undefined) for (const kid of node.kids) walk(kid.node);
    // default: a card without a tab list holds no tabs to restore.
    else for (const tab of node.data?.tabs ?? []) tabs.set(tab.id, tab.plugin);
  };
  // default: a project without spaces, or a space without a layout state, holds no tabs to restore.
  for (const project of allProjects()) for (const space of project.spaces ?? []) walk(space.layout?.state?.root);
  return tabs;
}

let restoring = null;

/** Starts the restart reconciliation once. The returned promise settles when it ends, and a failure is reported before it settles. */
export function startOwnedSessions() {
  // default: the reconciliation starts once, so its promise is created only while none is held, and an error without a message is reported by its value.
  restoring ??= reconcileOwnedSessions().catch((error) => report(`owned sessions: ${error?.message ?? error}`));
  return restoring;
}

/**
 * The restart of the page: each owned session that the sidecar still holds is adopted when its owner surface is in the restored layout,
 * and every other one is ended with reason owner-absent (docs/spec/persistent-services.md#owned-sessions). A sidecar that is not
 * reachable is reported, and the other sidecars are still read.
 */
export async function reconcileOwnedSessions() {
  await waitForInitialProjectContext();
  const tabs = restoredTabs();
  const names = [...new Set(plugins().filter((p) => p.sessions).map((p) => p.sessions))];
  for (const name of names) {
    try {
      const listed = await sidecarSessions(name);
      // A page without a host has no sidecar sessions.
      if (listed === null) continue;
      for (const item of listed.sessions) {
        const owner = tabs.get(item.surface);
        if (owner !== undefined && hasPlugin(owner) && plugin(owner).sessions === name) {
          sessions.set(item.session, { session: item.session, plugin: owner, owner: item.surface, shownBy: null, program: null, sidecar: name, size: sizeBody(item.size), pending: null });
          listenOwner(item.surface, windowSidecar(name));
          continue;
        }
        const reply = await windowSidecar(name).send(item.surface, { operation: "end", session: item.session });
        sessionReply("core.session.end (owner-absent)", reply, item.session);
        emitEvent("info", "workbench.session.end", { session: item.session, reason: "owner-absent" });
      }
    } catch (error) {
      // default: an error that is not an Error object is reported by its value.
      report(`owned sessions of sidecar ${name}: ${error?.message ?? error}`);
    }
  }
}
