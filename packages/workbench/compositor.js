// Compositor that simulates native surfaces.
//
// declared and applied share one record of one commit. Read separately, they would be two values of different
// times, and their difference could not be interpreted.
//
// This module does not know the structure of the plane. The plane writes the position and content of a surface
// into data attributes of the slot element, and this module reads those attributes to measure and report.
import { plugin } from "./registry.js";
import { native, surfaces as app } from "./host.js";
import { chromeRow, drawnFrameText } from "./frame-text.js";

const plane = document.getElementById("plane");

/* Receiver of completed commits. Verification connects here. */
let listener = null;

/** Registers the function that is called on every commit. */
export function onCommit(fn) {
  listener = fn;
}

/* Listener for the two ends of a run. */
let edge = null;

/**
 * Registers the function that is called when a run starts and when it ends.
 *
 * The application also detects the same two ends through the settled flag that the commit carries. Code inside
 * the page that has to know those two ends attaches here.
 */
export function onRun(fn) {
  edge = fn;
}

/** Whether updates are continuing now. */
let going = false;

let seq = 0;
let latestRecord = null;
let aheadRecord = null;
/* Number of the commit published ahead. The ahead record exists only when a commit with that number is made. */
let aheadSeq = -1;
let aheadComplete = false;
const drawn = new Map();

/** Element of the card that owns the slot: the ancestor that has the data-card-id the plane wrote. */
const cardEl = (slot) => slot.closest("[data-card-id]");

/** Returns the last commit record, or null when there is none. */
export const latest = () => latestRecord;

/**
 * Record published ahead by the previous render, or null when nothing was published ahead.
 *
 * When the render ends, the measured record becomes the last commit, so whether the prediction was right can
 * be known only by comparing against this value then.
 */
export const ahead = () => aheadRecord;

/* Last record for which the host answered up to the actual position. The answer arrives asynchronously, so the
   latest commit may not have it yet. The check that compares declaration and application reads this value. */
let seatedRecord = null;

/** Last record filled up to the actual position, or null when there is none. */
export const seated = () => seatedRecord;

/** Whether the latest DOM commit is waiting for the native placement answer of the host. */
export const placementPending = () => Boolean(
  latestRecord && (!seatedRecord || latestRecord.seq > seatedRecord.seq),
);

function surfaceEl(id) {
  let el = drawn.get(id);
  if (el) return el;
  el = document.createElement("div");
  el.className = "surface";
  el.style.position = "absolute";
  el.style.overflow = "hidden";
  el.dataset.nativeSurfaceId = id;
  plane.appendChild(el);
  drawn.set(id, el);
  return el;
}

/**
 * Whether this surface is shown now.
 *
 * The DOM cannot draw over a native surface, so while something is drawn over a surface, capture-hidden hides
 * the surface and the DOM draws a snapshot.
 */
const effectiveVisible = (slot) => {
  const { width, height } = slot.getBoundingClientRect();
  return slot.dataset.nativeCaptureHidden !== "true" && slot.closest("[hidden]") === null && width > 0 && height > 0;
};

/* Whether this commit is the last update, or updates are continuing.
   While a divider is dragged, a commit occurs on every frame, and it stops on release. The view sets
   data-dragging on the divider while dragging and removes it before the last render on release, so the last
   render returns true.

   The code that draws surfaces selects its way of applying by this value. It conveys only whether more updates
   follow, not the cause of the change. */
const settled = () => plane.querySelector(".sp-divider[data-dragging]") === null;

/** List of surface slots. Reads the data attributes that the plane wrote as they are. */
const slots = () =>
  plane.querySelectorAll("[data-native-surface][data-native-surface-id]");

/* Style node that holds the paint clip. body::before is not an element, so inline style cannot clip it; a
   literal path is written into a style node of the document. Passing it through a custom property makes WebKit
   draw the clip of body::before wrongly and the whole document disappears. */
let paintClip = null;
/** Sequence number of the placement record last written into the paint clip. */
let clippedSeq = 0;
/** Placement request last sent to the host: the holes of the answer (rects, null before the answer) and the sequence number of the commit that drew it (drawnSeq). */
let sentPlacement = null;

/**
 * Writes the holes of commit seq into the clip on the next frame. Answers can arrive in an order different from
 * the requests. Under load, if the answer of an earlier placement during a drag arrives later than the answer
 * of a later placement, the holes of the earlier placement would overwrite those of the later one, so only the
 * holes of a commit newer than the one already written are written.
 */
function clipNextFrame(seq, rects) {
  requestAnimationFrame(() => {
    if (seq < clippedSeq) return;
    clippedSeq = seq;
    syncNativePaintClip(rects);
  });
}

/** Excludes only the rectangles of the shown native surfaces from the app background as holes in actual pixels. */
function syncNativePaintClip(rects) {
  if (!native) {
    paintClip?.remove();
    paintClip = null;
    return;
  }
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  // A hole is wound opposite to the outer rectangle so that the default nonzero rule subtracts it. The evenodd
  // keyword form is supported differently by each engine, but every engine that knows path() interprets the
  // winding direction the same way.
  const holes = rects.map((rect) =>
    `M${rect.x},${rect.y}v${rect.h}h${rect.w}v${-rect.h}Z`).join("");
  // Creating a new data URL for every commit makes the web process keep a decoded image per URL, so memory grows
  // from window resizing alone (V5-96-14-6-4-7). A path creates no image resource, so rewriting it on every
  // commit leaves nothing behind. Path coordinates refer to the border box of the element, and body::before is
  // fixed with inset:0, so viewport coordinates are used as they are.
  // The clip is applied only to body::before. The background is painted only there, and unlike a mask,
  // clip-path also blocks pointer events in the clipped area, so clipping body would interrupt a drag over a hole.
  const rule = `body::before{clip-path:path("M0,0H${width}V${height}H0Z${holes}")}`;
  if (!paintClip) {
    paintClip = document.createElement("style");
    // The modal document copies the styles of the main document but does not copy this clip (docs/spec/native-modals.md).
    paintClip.dataset.nativePaintClip = "";
    document.head.appendChild(paintClip);
  }
  paintClip.textContent = rule;
}

/**
 * Measures the current slots and commits them.
 *
 * Works only by call. It does not watch position changes; the code that decides the position calls it. The commit holds the height of the first drawn row.
 */
export function publish() {
  const mine = ++seq;
  const host = plane.getBoundingClientRect();
  const snapshot = [];
  for (const slot of slots()) {
    const r = slot.getBoundingClientRect();
    const frame = { x: r.left - host.left, y: r.top - host.top, w: r.width, h: r.height };
    snapshot.push({
      id: slot.dataset.nativeSurfaceId,
      layer: Number(slot.dataset.nativeLayer),
      title: slot.dataset.nativeTitle,
      plugin: slot.dataset.nativePlugin,
      dim: slot.dataset.nativeDim === "true",
      visible: effectiveVisible(slot),
      frame,
    });
  }
  return deliver(mine, snapshot, chromeRow(drawnFrameText()));
}

/** Commits this snapshot and reports the edge of a run when a run started or ended. titlebar is the height of the first row of that placement. */
function deliver(mine, snapshot, titlebar) {
  const running = !settled();
  if (running !== going) {
    going = running;
    // default: the run-edge listener exists only when one was registered.
    edge?.(going);
  }
  return commit(mine, snapshot, !running, titlebar);
}

/**
 * Prepares the next card placement. An existing surface whose position cannot be calculated is hidden first.
 * titlebar is the height of the first row that the next drawing will show, and the host sets the window title
 * bar to that height in the same transaction (docs/spec/native-surfaces.md#title-bar-height).
 */
export function publishAhead(rects, seated, titlebar) {
  aheadRecord = null;
  aheadComplete = true;
  const seats = [];
  for (const slot of slots()) {
    const id = slot.dataset.nativeSurfaceId;
    const el = cardEl(slot);
    const card = el && rects.get(el.dataset.cardId);
    const seat = el && seated.get(el.dataset.cardId);
    const inset = seat ? seat.inset : null;
    if (seat && inset !== null && (!inset || ["left", "top", "width", "height"].some(
      key => !Number.isFinite(inset[key]) || inset[key] < 0))) {
      throw new Error(`invalid target surface inset ${id}`);
    }
    const measurable = Boolean(card && seat?.id === id && inset
      && card.w >= inset.width && card.h >= inset.height);
    if (!measurable) aheadComplete = false;
    seats.push({
      id,
      layer: Number(slot.dataset.nativeLayer),
      title: slot.dataset.nativeTitle,
      plugin: slot.dataset.nativePlugin,
      dim: seat?.dim === true,
      // default: a surface without a seat has no predicted bands (null).
      bands: seat?.bands ?? null,
      // The preparation is applied inside the layer transaction of the window and does not appear on screen before
      // the commit. A surface whose position was measured stays visible at its new seat, so the surface that is
      // visible on screen receives input meanwhile. Only a surface whose seat cannot be measured is hidden.
      visible: measurable,
      frame: measurable ? {
        x: card.x + inset.left,
        y: card.y + inset.top,
        w: card.w - inset.width,
        h: card.h - inset.height,
      } : { x: 0, y: 0, w: 0, h: 0 },
    });
  }
  aheadComplete &&= seats.length === seated.size;
  aheadSeq = ++seq;
  return deliver(aheadSeq, seats, titlebar);
}

/**
 * The only function that writes native state.
 *
 * `deliver` cancels earlier commits and the sequence only grows, so the snapshot that arrives here is always
 * the most recent one.
 */
function commit(mine, snapshot, final, titlebar) {
  const record = { seq: mine, settled: final, drawn: mine !== aheadSeq, titlebar, surfaces: [] };
  const kinds = app.kinds;
  for (const s of snapshot) {
    // Without a host, this module simulates the surface, so it decides the applied position here too.
    // With a host, the host answers with the seat it actually applied, and the answer replaces this value
    // below.
    const seat = { ...s.frame };
    const declared = {
      id: s.id, plugin: s.plugin, layer: s.layer, declared: s.frame, applied: seat,
      visible: s.visible, dim: s.dim,
      // default: a surface of a measured commit has no predicted bands (null).
      bands: s.bands ?? null,
      // The plugin decides what a surface shows. If the host branched by kind, the host would have to change
      // every time a plugin is added.
      surface: plugin(s.plugin).surface(s.id),
    };
    // No simulation element is created for a surface that the host draws natively. If both were created, the
    // DOM copy would remain below the native view.
    if (kinds.includes(s.plugin)) {
      record.surfaces.push(declared);
      continue;
    }
    const el = surfaceEl(s.id);
    el.style.left = `${seat.x}px`; el.style.top = `${seat.y}px`;
    el.style.width = `${seat.w}px`; el.style.height = `${seat.h}px`;
    el.style.zIndex = String(50 + s.layer);
    el.dataset.hidden = String(!s.visible);
    el.dataset.dim = String(s.dim);
    // The label is updated only when its value changes. A commit occurs on every frame, but the title and layer
    // rarely change, so writing every time would recreate the content of the surface on every frame.
    const label = `<b>${s.title}</b><br>네이티브 표면 · ${s.plugin} · layer ${s.layer}`;
    if (el.dataset.label !== label) { el.innerHTML = label; el.dataset.label = label; }
    record.surfaces.push(declared);
  }
  for (const [id, el] of drawn) {
    if (!record.surfaces.some((x) => x.id === id)) {
      el.remove(); drawn.delete(id);
    }
  }
  latestRecord = record;
  // The ahead record exists only when the prediction was committed under that same number. A measured commit that
  // follows the prediction has its own number, so the prediction is not published.
  if (mine === aheadSeq && aheadComplete) aheadRecord = record;
  // This module does not decide what is sent to the host. The surfaces of this plane alone are not enough; the
  // surfaces of other spaces must stay alive too.
  //
  // Returns the value of the listener as it is. The code that committed before rendering waits for this value.
  // default: a commit before a listener is registered has nowhere to report to.
  const answered = listener?.(record);
  if (answered && typeof answered.then === "function") {
    // A preparation reply is not a confirmation of display. Its holes are written into the clip only when a commit
    // drew the placement of this request. When the drawing commit equals this request and nothing was sent, that
    // commit leaves the drawnSeq.
    const entry = { rects: null, drawnSeq: record.drawn ? record.seq : 0 };
    sentPlacement = entry;
    return answered.then((placed) => {
      seat(record, placed);
      // The DOM at callback time may already have drawn the next placement, so the coordinates are kept here.
      const origin = plane.getBoundingClientRect();
      entry.rects = record.surfaces.filter((surface) =>
        surface.visible && app.kinds.includes(surface.plugin)).map(({ applied }) => ({
          x: origin.left + applied.x, y: origin.top + applied.y, w: applied.w, h: applied.h,
        }));
      if (entry.drawnSeq) clipNextFrame(entry.drawnSeq, entry.rects);
      return placed;
    });
  }
  // When the drawing commit equals the request sent just before and nothing was sent, the screen shows the
  // placement of that request. Its holes are written, or, if the answer has not arrived yet, when it arrives.
  if (native && record.drawn && !answered && sentPlacement) {
    sentPlacement.drawnSeq = record.seq;
    if (sentPlacement.rects) clipNextFrame(record.seq, sentPlacement.rects);
  }
  // Without a host, the seat this module placed is the actual seat. With a host but no answer, the request equals
  // the previous one and was not sent, so the seat last answered stays valid. Storing this record then would
  // record the simulated seat as the actual seat.
  if (!native) seatedRecord = record;
  return answered;
}

/**
 * Puts the actual position that the host answered into the record.
 *
 * The declared rectangle and the actual seat differ, because the host aligns to display pixels. The verifier
 * must be able to measure that difference, so the answer is recorded as it is.
 */
function seat(record, placed) {
  const at = new Map(placed.map((p) => [p.id, p]));
  for (const s of record.surfaces) {
    const now = at.get(s.id);
    if (native && app.kinds.includes(s.plugin)) {
      if (!now) throw new Error(`missing native placement ${s.id}`);
      if (typeof now.visible !== "boolean") throw new Error(`invalid native placement visibility ${s.id}`);
      if (![now.x, now.y, now.w, now.h].every(Number.isFinite) || now.w < 0 || now.h < 0)
        throw new Error(`invalid native placement geometry ${s.id}`);
      s.visible = now.visible;
    }
    if (now) s.applied = { x: now.x, y: now.y, w: now.w, h: now.h };
  }
  if (!seatedRecord || record.seq >= seatedRecord.seq) seatedRecord = record;
}

/**
 * Hides the surface and shows a `.standin` at the same position.
 *
 * A native surface is an OS view, so the DOM cannot draw over it. While the DOM draws over a surface,
 * capture-hidden hides the surface and a `.standin` is shown instead; surface updates are suspended meanwhile
 * and restored at the end.
 *
 * The `.standin` is displayed identically to the surface. The screen must not change while the surface is hidden.
 *
 * When `over` is given, only the surfaces that overlap that area are hidden. The drop region targets the whole
 * plane, but the picker layer is small, so hiding everything would suspend updates of non-overlapping surfaces too.
 */
export function standIn(on, over) {
  const area = over ? plane.getBoundingClientRect() : null;
  const kinds = app.kinds;
  for (const slot of slots()) {
    // A native surface shows a running page or program. Hiding it to draw the DOM would turn what the user was
    // watching into a still image, so it is not hidden.
    if (kinds.includes(slot.dataset.nativePlugin)) {
      delete slot.dataset.nativeCaptureHidden;
      continue;
    }
    let hide = on;
    if (hide && over) {
      const r = slot.getBoundingClientRect();
      hide = over.x < r.right - area.left && over.x + over.w > r.left - area.left
          && over.y < r.bottom - area.top && over.y + over.h > r.top - area.top;
    }
    if (hide) slot.dataset.nativeCaptureHidden = "true";
    else delete slot.dataset.nativeCaptureHidden;
    slot.innerHTML = "";
    if (!hide) continue;

    // Clones what the surface last showed. Rebuilding from the model would show the current model, not the one at
    // the time of hiding, and the two differ when the model changed after the last commit.
    const id = slot.dataset.nativeSurfaceId;
    const shown = drawn.get(id);
    if (!shown) continue;
    const el = document.createElement("div");
    el.className = "standin";
    el.innerHTML = shown.innerHTML;
    // Placed at the position where the surface was. At the declared position it would be off by the applied error.
    const rec = latestRecord?.surfaces.find((x) => x.id === id);
    if (rec) el.style.transform =
      `translate(${rec.applied.x - rec.declared.x}px,${rec.applied.y - rec.declared.y}px)`;
    slot.appendChild(el);
  }
  publish();
}
