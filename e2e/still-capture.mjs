import { dirname } from "node:path";
import { readPng } from "@soksak/window-check/png.mjs";

/** Acquires and decodes a still without changing the caller's readiness timing. */
export async function readStillCapture(session, t) {
  const { path } = await session.request("diagnostics.capture.still", {});
  session.trackRecording(dirname(path));
  t.diagnostic(`still capture: ${path}`);
  return { path, image: readPng(path) };
}
