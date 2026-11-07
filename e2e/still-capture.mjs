import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { readPng } from "@soksak/window-check/png.mjs";

/** Acquires and decodes a still without changing the caller's readiness timing. */
export async function readStillCapture(session, t) {
  const { path } = await session.request("diagnostics.capture.still", {});
  session.trackRecording(dirname(path));
  t.diagnostic(`still capture: ${path}`);
  return { path, image: readPng(path) };
}

/** Retains the original state PNG outside session-owned capture cleanup. */
export async function retainDesignStateCapture(session, t, state, { runFolder = process.env.SOKSAK_RUN_FOLDER } = {}) {
  if (typeof runFolder !== "string" || !runFolder || !isAbsolute(runFolder)) {
    throw new Error("SOKSAK_RUN_FOLDER must declare an absolute folder for retained design-state captures");
  }
  const component = (value, label) => {
    if (typeof value !== "string" || !value || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\u0000")) {
      throw new Error(`design capture ${label} must be one nonempty path component`);
    }
    return value;
  };
  const host = component(session.app.name, "host"), name = component(state, "state");
  const { path: source } = await readStillCapture(session, t);
  const directory = join(runFolder, "design-hosts", host);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${name}.png`);
  copyFileSync(source, path);
  t.diagnostic(`design state ${host} ${state}: ${path}`);
  return { path };
}
