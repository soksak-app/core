// Diagnostic methods on the page side.
//
// When the host of a diagnostic build requests them with exposure-request, this document performs them: diagnostics.fixture, which returns
// the settings and projects to the state before the check; diagnostics.drag, which drives a boundary given by name on the clock of the host;
// diagnostics.transcript, which turns the call record on and off; and diagnostics.surface.hold and
// diagnostics.surface.held, which hold the exposure reply of a surface until that surface is removed. The steps of a drag arrive as the host event diagnostics-tick.
//
// Both applications run this file, so how to drive a drag is written only once.
// It does not run unless the host requests it.
import { registry } from "./exposure.js";
import { gateSurfaceReplies, log, native, watchCalls } from "./host.js";
import { createTranscript } from "./transcript.js";
import { createSurfaceReplyHold } from "./surface-reply-hold.js";
import { mountedSurface } from "./surface-modules.js";
import { watchResizeLoop } from "./resize-loop.js";
import { host } from "@soksak/runtime";
import { currentGrid, surfaceInput } from "./plane.js";

// Writes the observations that the ResizeObserver loop deferred to the application log (G1.4-115). It is replaced before the plane and the regions create observers.
watchResizeLoop(globalThis, log);

registry.method("diagnostics.fixture", async ({ root, settings: overrides }) => {
  if (typeof root !== "string" || !root) throw new Error("diagnostics.fixture requires root");
  if (overrides !== undefined && (typeof overrides !== "object" || overrides === null || Array.isArray(overrides))) {
    throw new Error("diagnostics.fixture settings must be an object");
  }
  const projects = await import("./projects.js");
  const settings = await import("./settings.js");
  const plane = await import("./plane.js");
  await projects.flush();
  for (const project of [...projects.all()]) await projects.close(project.id);
  // The common settings given by the check are applied together with the defaults in one step. A surface that opens starts with those values, and the change notification is sent once.
  await settings.set({ ...structuredClone(settings.defaults), ...overrides }, "common");
  await projects.open({ root, color: "#ffb36b", layout: plane.fresh() });
  await projects.flush();
  return { root };
});

// Call recorder. The recorder is in this package, so both applications write the same format and order.
const transcript = createTranscript(log);
if (native) watchCalls((name, payload, answered) => transcript.record(name, payload, answered));

registry.method("diagnostics.transcript", ({ on }) => {
  transcript.set(on === true);
  return null;
});

registry.method("diagnostics.drag", (plan) => shake(plan));

// The page requests a file of its application and answers the status, so a check can make the host report a file that
// does not exist (docs/spec/diagnostics.md).
registry.method("diagnostics.page.request", async ({ path }) => {
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error("diagnostics.page.request requires a path that starts with /");
  const response = await fetch(path);
  return { path, status: response.status };
});

// The reply of a held surface is sent after the host reports that it removed the surface (docs/spec/endpoint.md). That reply arrives after the request has ended.
const replyHold = createSurfaceReplyHold(log);
gateSurfaceReplies(replyHold.gate);
host?.on("exposure-registered", (event) => {
  if (event?.closed) return replyHold.closed(event.surface);
});

registry.method("diagnostics.surface.hold", ({ surface }) => {
  if (typeof surface === "string" && surface && !mountedSurface(surface)) throw new Error(`surface ${surface} is not mounted`);
  replyHold.hold(surface);
  return null;
});

registry.method("diagnostics.surface.held", async ({ surface }) => {
  await replyHold.held(surface);
  return null;
});

host?.on("diagnostics-tick", () => {
  if (waiting) {
    const go = waiting;
    waiting = null;
    go();
  } else {
    pending++;
  }
});

/**
 * The time of a step is given by the host.
 *
 * When the window is not in front, the browser treats this document as hidden and throttles setTimeout to nearly one second.
 * If a step requested at 16 ms stretches that much, the drag no longer runs at the speed of a person dragging, and a
 * defect that appears only at that speed does not appear. The clock of the host is not delayed wherever the window is,
 * so this file states what the drag is, and the host gives the time of each step
 * with the diagnostics-tick event.
 *
 * Arrived steps are counted. If the next step arrives while this document is processing one step, nothing is
 * waiting for it yet.
 */
let pending = 0;
let waiting = null;

/* Number of steps that arrived before this document waited, and number of steps that were queued that way. If both are 0,
   this document kept up with the steps of the host in time, and the drag has exactly the requested shape. */
let deepest = 0;
let late = 0;

const tick = () => {
  if (pending > 0) {
    deepest = Math.max(deepest, pending);
    late++;
    pending--;
    return Promise.resolve();
  }
  return new Promise((go) => {
    waiting = go;
  });
};

/** Length of one step: the interval at which the screen updates. The host sends steps with the same value. */
const FRAME = 16;

/**
 * Shakes the boundary given by name and, when it ends, returns the elapsed time and the late steps.
 *
 * The boundary is given by axis and line number, not by coordinates. With coordinates, the values would have to be set again
 * whenever the window size differs, and a miss does nothing.
 *
 * Each step is delivered through the same path as a press on a surface. The host sends steps × 2 × times
 * diagnostics-tick events at the FRAME interval.
 */
async function shake({ axis, line, dx, dy, ms, times }) {
  const divider = document.querySelector(
    `.sp-divider[data-axis="${axis}"][data-line="${line}"]`);
  if (!divider) throw new Error(`no ${axis} boundary at line ${line}`);
  const box = divider.getBoundingClientRect();
  const from = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  const steps = Math.max(1, Math.round(ms / FRAME));

  // It moves back and forth with one press held. If the pointer were released and pressed again, the next press would miss when the boundary stopped at the minimum card size
  // and did not move by the given amount.
  // Steps that an earlier drag received and did not use do not belong to this drag. If they were kept, this
  // drag would consume them at once and end earlier than requested.
  pending = 0;
  waiting = null;
  late = 0;
  deepest = 0;
  surfaceInput({ phase: 0, x: from.x, y: from.y });
  // Position of the boundary on the grid at each step. The boundary snaps to a neighboring line or stops at the minimum size, so
  // it is not equal to the pointer position. The layout of a recorded screen is matched to its step with this value.
  const boundary = [currentGrid().boundaryPos(axis, line)];
  // Time (ms) in which this document applied the input and computed the layout at each step. It shows whether the early steps are slow.
  const handled = [];
  const began = performance.now();
  for (let turn = 0; turn < times; turn++) {
    await sweep(from, dx, dy, 0, 1, steps, () => boundary.push(currentGrid().boundaryPos(axis, line)), handled);
    await sweep(from, dx, dy, 1, 0, steps, () => boundary.push(currentGrid().boundaryPos(axis, line)), handled);
  }
  const took = performance.now() - began;
  surfaceInput({ phase: 2, x: from.x, y: from.y });
  // This clock belongs to the page. The browser throttles it when the window is not in front, so the elapsed
  // time is returned together.
  return {
    from, steps: times * 2 * steps, took: Math.round(took), asked: times * 2 * steps * FRAME,
    late, deepest, boundary, handled,
  };
}

/** Moves the pressed point from one fraction of the offset to another and calls moved at each step. */
async function sweep(from, dx, dy, start, end, steps, moved, handled) {
  for (let i = 1; i <= steps; i++) {
    await tick();
    const at = start + (end - start) * (i / steps);
    const began = performance.now();
    surfaceInput({ phase: 1, x: from.x + dx * at, y: from.y + dy * at });
    moved();
    handled.push(Math.round((performance.now() - began) * 10) / 10);
  }
}
